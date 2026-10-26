import { describe, it, expect, afterEach } from "vitest";
import { Store } from "./store.js";
import { ensureRepo } from "../attach.js";
import { ingestFile } from "../ingest.js";
import { observeBatch } from "../../sync/observe.js";
import { pinClock } from "../clock.js";
import { listActiveAlerts } from "./alerts.js";
import { bindCapabilities } from "../capabilities/registry.js";
import { coreCapabilities } from "../capabilities/core.js";
import { CaptureFailed, CapabilityUnavailable, HISTORY_DISABLED_MESSAGE, HISTORY_UNAVAILABLE_MESSAGE, captureFailedMessage } from "../capabilities/errors.js";
import type { Capabilities, HistoryRecorder } from "../capabilities/types.js";
import { errorBody } from "../../mcp/errors.js";
import { readDocumentAtRevision } from "../read/document.js";
import { runGc } from "./gc.js";
import { rebuildIndex } from "./rebuild.js";
import { sizeReport } from "./size.js";
import {
  CAPTURE_FAILED_ALERT, HISTORY_ENABLED_REASON, captureFor, disableHistory, enableHistory, historyBundlePresent, historyReader, readCapability, requireHistoryReader,
} from "./manifest.js";

// The capture lifecycle (spec/store §5.9 — store 17.0 Phase 4a; phase-1-
// contracts §1.14, §7 resolutions 17 and 18): `history enable|disable` over the
// manifest, the recorder attached per repository through `captureFor`, the
// baseline commit, the history bundle's DDL following the manifest, and a
// capture that throws rolling the member back under a `capture_failed` alert.

const T0 = "2026-10-20T10:00:00.000Z";
const T1 = "2026-10-20T10:01:00.000Z";
const T2 = "2026-10-20T10:02:00.000Z";
const T3 = "2026-10-20T10:03:00.000Z";
const T4 = "2026-10-20T10:04:00.000Z";

let store: Store | undefined;
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; store?.close(); store = undefined; });

function open(): { store: Store; repoId: string } {
  restore = pinClock(T0);
  const s = new Store({ path: ":memory:" });
  store = s;
  return { store: s, repoId: ensureRepo(s, "fixture", null) };
}
const count = (s: Store, table: string): number => (s.db.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c;
const tableExists = (s: Store, name: string): boolean => !!s.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/** The default recorder with every capture call throwing — resolution 18's test seam. */
function failTheRecorder(s: Store, fail: boolean): void {
  const original = (s as unknown as { __recorder?: HistoryRecorder | null }).__recorder ?? s.capabilities.history;
  (s as unknown as { __recorder?: HistoryRecorder | null }).__recorder = original;
  const faulty = fail && original
    ? new Proxy(original, { get(t, k, r) { return ["recordCommit", "captureRevision", "recordDispositions", "recordEdgeTransitions"].includes(String(k)) ? () => { throw new Error("disk full"); } : Reflect.get(t, k, r) as unknown; } })
    : original;
  const caps: Capabilities = { ...s.capabilities, history: faulty };
  (s as { capabilities: Capabilities }).capabilities = caps;
  bindCapabilities(s.db, caps);
}

describe("the composition rule (spec/store §3.1 — the bundle follows the manifest)", () => {
  it("a fresh database has the core and semantic tables only; the first enabled repository brings the history bundle", () => {
    restore = pinClock(T0);
    const s = new Store({ path: ":memory:" });
    store = s;
    expect(tableExists(s, "commits")).toBe(false);
    expect(tableExists(s, "embeddings")).toBe(true);
    expect(historyBundlePresent(s.db)).toBe(false);
    const repoId = ensureRepo(s, "a", null);
    expect(tableExists(s, "commits")).toBe(true);
    expect(readCapability(s.db, repoId, "history")).toMatchObject({ state: "enabled", coverage: [{ from: T0, to: null }], writer_requires: true });
  });

  it("ensureRepo({ history: false }) creates the repository with capture off and no bundle; its writes record nothing but the feed", () => {
    restore = pinClock(T0);
    const s = new Store({ path: ":memory:" });
    store = s;
    const repoId = ensureRepo(s, "quiet", null, { history: false });
    expect(readCapability(s.db, repoId, "history")).toMatchObject({ state: "disabled", coverage: [], writer_requires: false });
    expect(tableExists(s, "commits")).toBe(false);
    expect(captureFor(s.db, repoId)).toBeNull();
    const r = ingestFile(s, repoId, "a.md", "# A\n\nbody\n", { ts: T1 });
    expect(r.converged).toBe(true);
    expect(count(s, "feed")).toBe(1);
    expect(tableExists(s, "revisions")).toBe(false);
    // The reads: nothing captured → the recorder is unreachable for reads, the current head reads from the rows elsewhere (resolution 11).
    expect(historyReader(s.db)).toBeNull();
    expect(() => requireHistoryReader(s.db)).toThrow(HISTORY_DISABLED_MESSAGE);
    expect(readDocumentAtRevision(s, r.docId, r.revId)).toBeNull();
    // gc / rebuild-index / the size report run without the bundle.
    expect(runGc(s, { enabled: true, now: T2 })).toEqual({ blobsSwept: 0, treeNodesSwept: 0, sameDispositionsSwept: 0, claimsReleased: 0, feedPruned: 0 });
    expect(() => rebuildIndex(s)).not.toThrow();
    const size = sizeReport(s, { repoId });
    expect(size.same_dispositions).toBe(0);
    expect(size.archived).toEqual({ revisions: 0, segments: 0, bytes: 0 });
    expect(size.categories.find((c) => c.name === "history")!.tables).toEqual([]);
  });

  it("two repositories: the enabled one captures, the disabled one does not, in the same database", () => {
    const { store: s, repoId: on } = open();
    const off = ensureRepo(s, "off", null, { history: false });
    ingestFile(s, on, "a.md", "# A\n", { ts: T1 });
    ingestFile(s, off, "b.md", "# B\n", { ts: T1 });
    expect(count(s, "feed")).toBe(2);
    expect(count(s, "commits")).toBe(1);
    expect(count(s, "revisions")).toBe(1);
    expect(captureFor(s.db, on)).not.toBeNull();
    expect(captureFor(s.db, off)).toBeNull();
  });
});

describe("history disable / enable (spec/store §5.9)", () => {
  it("disable closes the interval, stops the capture in-process, keeps the rows; writes and CAS go on", () => {
    const { store: s, repoId } = open();
    const r0 = ingestFile(s, repoId, "a.md", "# A\n\none\n", { ts: T1 });
    const d = disableHistory(s.db, repoId, { now: T2 });
    expect(d.changed).toBe(true);
    expect(d.row).toMatchObject({ state: "disabled", coverage: [{ from: T0, to: T2 }], writer_requires: false });
    expect(disableHistory(s.db, repoId, { now: T3 }).changed).toBe(false);
    const r1 = ingestFile(s, repoId, "a.md", "# A\n\ntwo\n", { ts: T3 });
    expect(r1.revId).not.toBe(r0.revId);
    expect(count(s, "feed")).toBe(2);
    expect(count(s, "commits")).toBe(1);
    expect(count(s, "revisions")).toBe(1);
    // The head moved (CAS reads `docs.head`), the recorder's bit never set on the new ids.
    expect((s.db.prepare("SELECT head FROM docs WHERE doc_id = ?").get(r1.docId) as { head: string }).head).toBe(r1.revId);
    expect((s.db.prepare("SELECT holders FROM id_claims WHERE id = ?").get(r1.revId) as { holders: number }).holders).toBe(1);
    expect((s.db.prepare("SELECT holders FROM id_claims WHERE id = ?").get(r0.revId) as { holders: number }).holders).toBe(3);
    // What was captured stays readable; the uncaptured head has no row.
    expect(readDocumentAtRevision(s, r0.docId, r0.revId)?._raw).toBe("# A\n\none\n");
    expect(readDocumentAtRevision(s, r1.docId, r1.revId)).toBeNull();
    expect(historyReader(s.db)).not.toBeNull();
  });

  it("enable writes the baseline — one import feed row, the commits row, a checkpoint revision per uncaptured head, the holds — then captures again; idempotent", () => {
    const { store: s, repoId } = open();
    const r0 = ingestFile(s, repoId, "a.md", "# A\n\none\n", { ts: T1 });
    disableHistory(s.db, repoId, { now: T2 });
    const r1 = ingestFile(s, repoId, "a.md", "# A\n\ntwo\n", { ts: T3 });
    const b = ingestFile(s, repoId, "b.md", "# B\n", { ts: T3 });
    const e = enableHistory(s.db, repoId, { now: T4 });
    expect(e.changed).toBe(true);
    expect(e.baseline).toEqual({ commit: expect.stringMatching(/^c_/), revisions: 2 });
    expect(e.row).toMatchObject({ state: "enabled", coverage: [{ from: T0, to: T2 }, { from: T4, to: null }], writer_requires: true });
    const feed = s.db.prepare("SELECT seq, origin, reason, commit_id FROM feed ORDER BY seq").all() as { seq: number; origin: string; reason: string | null; commit_id: string }[];
    expect(feed.map((f) => [f.seq, f.origin, f.reason])).toEqual([[1, "observed", null], [2, "observed", null], [3, "observed", null], [4, "import", HISTORY_ENABLED_REASON]]);
    const entries = s.db.prepare("SELECT doc_id, head, kind FROM feed_entries WHERE seq = 4 ORDER BY rowid").all() as { doc_id: string; head: string; kind: string }[];
    expect(entries).toEqual([{ doc_id: r1.docId, head: r1.revId, kind: "changed" }, { doc_id: b.docId, head: b.revId, kind: "changed" }]);
    expect(s.db.prepare("SELECT commit_id, seq FROM commits ORDER BY seq").all()).toEqual([{ commit_id: feed[0]!.commit_id, seq: 1 }, { commit_id: e.baseline!.commit, seq: 4 }]);
    expect(s.db.prepare("SELECT rev_id, seq, commit_id FROM revisions ORDER BY doc_id, seq").all()).toEqual(expect.arrayContaining([
      { rev_id: r0.revId, seq: 1, commit_id: feed[0]!.commit_id }, { rev_id: r1.revId, seq: 2, commit_id: e.baseline!.commit }, { rev_id: b.revId, seq: 1, commit_id: e.baseline!.commit },
    ]));
    // The baseline revision reads back byte for byte; the recorder holds the heads.
    expect(readDocumentAtRevision(s, r1.docId, r1.revId)?._raw).toBe("# A\n\ntwo\n");
    expect((s.db.prepare("SELECT holders FROM id_claims WHERE id = ?").get(r1.revId) as { holders: number }).holders).toBe(3);
    // Idempotent: a second enable changes nothing and writes no second baseline.
    expect(enableHistory(s.db, repoId, { now: "2026-10-20T10:05:00.000Z" })).toMatchObject({ changed: false, baseline: null });
    expect(count(s, "feed")).toBe(4);
    // Capture is on again: the next commit has its rows, a delta against the baseline.
    const r2 = ingestFile(s, repoId, "a.md", "# A\n\nthree\n", { ts: "2026-10-20T10:06:00.000Z" });
    expect(count(s, "commits")).toBe(3);
    expect(s.db.prepare("SELECT seq FROM revisions WHERE rev_id = ?").get(r2.revId)).toEqual({ seq: 3 });
  });

  it("enable --best-effort records writer_requires 0; enable needs the module", () => {
    const { store: s, repoId } = open();
    disableHistory(s.db, repoId, { now: T1 });
    expect(enableHistory(s.db, repoId, { now: T2, writerRequires: false }).row.writer_requires).toBe(false);
    const bare = new Store({ path: ":memory:", capabilities: coreCapabilities });
    try {
      const r = ensureRepo(bare, "x", null);
      expect(() => enableHistory(bare.db, r)).toThrow(HISTORY_UNAVAILABLE_MESSAGE);
      expect(disableHistory(bare.db, r).changed).toBe(false);
    } finally {
      bare.close();
    }
  });
});

describe("writer_requires is reachable (resolution 17)", () => {
  it("a core-only build refuses a write on an enabled repository that requires capture, through every entry point; disable lets it through", () => {
    // Created by a full build (enabled, writer_requires 1), then opened by a core-only one: the same database, the composition rebound.
    const { store: s, repoId } = open();
    ingestFile(s, repoId, "a.md", "# A\n", { ts: T1 });
    const core = coreCapabilities(s);
    (s as { capabilities: Capabilities }).capabilities = core;
    bindCapabilities(s.db, core);
    let err: unknown;
    try { ingestFile(s, repoId, "a.md", "# A\n\nedit\n", { ts: T2 }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CapabilityUnavailable);
    expect((err as CapabilityUnavailable).state).toBe("unavailable");
    expect(listActiveAlerts(s.db, repoId).map((a) => a.code)).toEqual(["writer_refused"]);
    // The batch path refuses before any member commits (the alert survives: the check runs outside the transaction).
    expect(() => observeBatch(s, repoId, [{ path: "b.md", content: "# B\n" }], T2)).toThrow(CapabilityUnavailable);
    expect(count(s, "feed")).toBe(1);
    // An echo batch commits nothing and needs no writer.
    expect(observeBatch(s, repoId, [{ path: "a.md", content: "# A\n" }], T2).map((o) => o.kind)).toEqual(["observed"]);
    // Capture off: the core-only build writes, and the passing write clears the alert.
    disableHistory(s.db, repoId, { now: T3 });
    const r = ingestFile(s, repoId, "a.md", "# A\n\nedit\n", { ts: T4 });
    expect(r.converged).toBe(true);
    expect(listActiveAlerts(s.db, repoId)).toEqual([]);
    expect(count(s, "feed")).toBe(2);
    expect(count(s, "commits")).toBe(1);
  });
});

describe("capture failure rolls the member back (resolution 18)", () => {
  it("observeBatch: the failing member lands nothing, the others go on, capture_failed is raised and cleared by the next success", () => {
    const { store: s, repoId } = open();
    ingestFile(s, repoId, "a.md", "# A\n\none\n", { ts: T1 });
    failTheRecorder(s, true);
    const out = observeBatch(s, repoId, [{ path: "a.md", content: "# A\n\ntwo\n" }, { path: "b.md", content: "# B\n" }], T2);
    expect(out.map((o) => o.kind)).toEqual(["failed", "failed"]);
    expect(out[0]).toMatchObject({ path: "a.md", error: captureFailedMessage("a.md", "disk full") });
    // Nothing of either member landed.
    expect(count(s, "feed")).toBe(1);
    expect(count(s, "docs")).toBe(1);
    expect((s.db.prepare("SELECT file_hash FROM docs").get() as { file_hash: Buffer }).file_hash).toEqual((s.db.prepare("SELECT hash FROM feed_entries WHERE seq = 1").get() as { hash: Buffer }).hash);
    const alerts = listActiveAlerts(s.db, repoId);
    expect(alerts).toEqual([{ code: CAPTURE_FAILED_ALERT, severity: "error", message: captureFailedMessage("/b.md", "disk full"), since: T2, detail: { path: "/b.md", reason: "disk full" } }]);
    // One alert per repository (the last failure's detail); the next successful capture of that path clears it.
    failTheRecorder(s, false);
    const again = observeBatch(s, repoId, [{ path: "a.md", content: "# A\n\ntwo\n" }, { path: "b.md", content: "# B\n" }], T3);
    expect(again.map((o) => o.kind)).toEqual(["observed", "observed"]);
    expect(count(s, "feed")).toBe(3);
    expect(count(s, "commits")).toBe(3);
    expect(listActiveAlerts(s.db, repoId)).toEqual([]);
  });

  it("the envelope: capture_failed { path, reason }, retriable", () => {
    const e = new CaptureFailed(null, new Error("disk full")).at("a.md");
    expect(errorBody(e)).toEqual({ error: "capture_failed", message: captureFailedMessage("a.md", "disk full"), data: { path: "a.md", reason: "disk full" }, retriable: true });
    expect(captureFailedMessage(null, "x")).toBe("history capture of a commit failed: x — the write was rolled back and is retried by the next sweep; fix the recorder or run omg history disable");
    // `at` names the member once and keeps it.
    expect(new CaptureFailed(null, "boom").at("a.md").at("b.md").path).toBe("a.md");
  });
});
