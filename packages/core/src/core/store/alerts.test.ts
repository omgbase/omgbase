import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "./store.js";
import { ensureRepo } from "../attach.js";
import { ingestFile } from "../ingest.js";
import { writeRepoSettings } from "../../sync/settings.js";
import { materializePending } from "../../mutate/materialize.js";
import { NullDocStore } from "../../mutate/doc-store.js";
import {
  activeAlerts, alertAfterMinutes, clearAlert, listActiveAlerts, materializationBacklogMessage, materializationFailedMessage, raiseAlert, refreshBacklogAlert,
  MATERIALIZATION_BACKLOG_ALERT, MATERIALIZATION_FAILED_ALERT, RECOVERY_ALERT_AFTER_MINUTES_DEFAULT,
} from "./alerts.js";

// The alert channel (spec/store §3.1 `alerts`, §5.8 — 17.0, modular-core Phase
// 3e-ii): raise is idempotent and keeps `since`, clear stamps `cleared_at`, a
// cleared row is re-raised with a new `since`; the backlog condition is
// re-derived from the pending rows under `recovery.alert_after_minutes`; a
// replay that throws raises `materialization_failed` and the next clean pass
// clears it.

const T0 = "2026-09-26T10:00:00.000Z";
const T5 = "2026-09-26T10:05:00.000Z";
const T10 = "2026-09-26T10:10:00.000Z";
const T20 = "2026-09-26T10:20:00.000Z";

let store: Store;
let repoId: string;

beforeEach(() => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "fixture", null);
});
afterEach(() => store.close());

function plantPending(createdAt: string, path = "a.md"): void {
  store.db.prepare(
    `INSERT INTO pending_materializations (repo_id, path, kind, from_path, doc_id, head, rendered_hash, prior_hash, commit_id, created_at)
     SELECT repo_id, path, 'write', NULL, doc_id, head, file_hash, file_hash, 'c_0', ? FROM docs WHERE repo_id = ? AND path = ?`,
  ).run(createdAt, repoId, path);
}

describe("raise / clear", () => {
  it("raising is idempotent — since is kept, message and detail refreshed; detail {} is omitted on the wire", () => {
    raiseAlert(store.db, repoId, { code: "x", severity: "warning", message: "one" }, T0);
    raiseAlert(store.db, repoId, { code: "x", severity: "error", message: "two", detail: { n: 2, a: [1] } }, T5);
    expect(listActiveAlerts(store.db, repoId)).toEqual([{ code: "x", severity: "error", message: "two", since: T0, detail: { n: 2, a: [1] } }]);
    expect(store.db.prepare("SELECT detail FROM alerts WHERE code = 'x'").get()).toEqual({ detail: '{"a":[1],"n":2}' }); // canonical JSON
  });

  it("clear stamps cleared_at and hides the row; a cleared row re-raises in place with a new since", () => {
    raiseAlert(store.db, repoId, { code: "x", severity: "info", message: "m" }, T0);
    expect(clearAlert(store.db, repoId, "x", T5)).toBe(true);
    expect(clearAlert(store.db, repoId, "x", T5)).toBe(false);
    expect(listActiveAlerts(store.db, repoId)).toEqual([]);
    expect(store.db.prepare("SELECT cleared_at FROM alerts WHERE code = 'x'").get()).toEqual({ cleared_at: T5 });
    raiseAlert(store.db, repoId, { code: "x", severity: "info", message: "m" }, T10);
    expect(listActiveAlerts(store.db, repoId)).toEqual([{ code: "x", severity: "info", message: "m", since: T10 }]);
    expect(store.db.prepare("SELECT count(*) AS c FROM alerts").get()).toEqual({ c: 1 });
  });

  it("lists by since then code, per repository", () => {
    const other = ensureRepo(store, "other", null);
    raiseAlert(store.db, repoId, { code: "b", severity: "info", message: "m" }, T5);
    raiseAlert(store.db, repoId, { code: "a", severity: "info", message: "m" }, T5);
    raiseAlert(store.db, repoId, { code: "c", severity: "info", message: "m" }, T0);
    raiseAlert(store.db, other, { code: "z", severity: "info", message: "m" }, T0);
    expect(listActiveAlerts(store.db, repoId).map((a) => a.code)).toEqual(["c", "a", "b"]);
    expect(listActiveAlerts(store.db, other).map((a) => a.code)).toEqual(["z"]);
  });
});

describe("the materialization backlog", () => {
  it("is raised for pending rows older than recovery.alert_after_minutes (default 10), re-derived whenever the channel is read, cleared when the rows go", () => {
    ingestFile(store, repoId, "a.md", "# A\n\nbody\n", { ts: T0 });
    expect(alertAfterMinutes(store.db, repoId)).toBe(RECOVERY_ALERT_AFTER_MINUTES_DEFAULT);
    plantPending(T0);
    expect(activeAlerts(store.db, repoId, T5)).toEqual([]); // five minutes: below the threshold
    expect(activeAlerts(store.db, repoId, T10)).toEqual([{
      code: MATERIALIZATION_BACKLOG_ALERT,
      severity: "warning",
      message: materializationBacklogMessage(1, T0, 10),
      since: T10,
      detail: { pending: 1, oldest: T0, threshold_minutes: 10 },
    }]);
    expect(materializationBacklogMessage(1, T0, 10)).toBe("1 pending materialization older than 10 minutes (oldest 2026-09-26T10:00:00.000Z): the api path still owes the working tree these files — omg sync replays them");
    expect(materializationBacklogMessage(2, T0, 10)).toMatch(/^2 pending materializations older/);
    // Still standing later: since is kept.
    expect(activeAlerts(store.db, repoId, T20)[0]!.since).toBe(T10);
    store.db.prepare("DELETE FROM pending_materializations WHERE repo_id = ?").run(repoId);
    expect(activeAlerts(store.db, repoId, T20)).toEqual([]);
    expect(store.db.prepare("SELECT cleared_at FROM alerts WHERE code = ?").get(MATERIALIZATION_BACKLOG_ALERT)).toEqual({ cleared_at: T20 });
  });

  it("honors a repository's recovery.alert_after_minutes", () => {
    ingestFile(store, repoId, "a.md", "# A\n\nbody\n", { ts: T0 });
    writeRepoSettings(store, repoId, { recovery: { alert_after_minutes: 2 } });
    expect(alertAfterMinutes(store.db, repoId)).toBe(2);
    plantPending(T0);
    expect(activeAlerts(store.db, repoId, T5).map((a) => a.detail)).toEqual([{ pending: 1, oldest: T0, threshold_minutes: 2 }]);
    writeRepoSettings(store, repoId, { recovery: { alert_after_minutes: "soon" } }); // not a number: the default
    expect(alertAfterMinutes(store.db, repoId)).toBe(10);
  });

  it("a read of a quiet repository writes nothing", () => {
    ingestFile(store, repoId, "a.md", "# A\n\nbody\n", { ts: T0 });
    refreshBacklogAlert(store.db, repoId, T20);
    expect(store.db.prepare("SELECT count(*) AS c FROM alerts").get()).toEqual({ c: 0 });
  });
});

describe("a replay that fails", () => {
  class FailingStore extends NullDocStore {
    override read(): string | null { return null; }
    override write(path: string): void { throw new Error(`EACCES: cannot write ${path}`); }
  }

  it("raises materialization_failed (error) with the path and reason, keeps the row, and the error propagates; a clean pass clears it", () => {
    ingestFile(store, repoId, "a.md", "# A\n\nbody\n", { ts: T0 });
    plantPending(T0);
    expect(() => materializePending(store, repoId, new FailingStore())).toThrow(/EACCES/);
    const active = listActiveAlerts(store.db, repoId);
    expect(active.map((a) => a.code).sort()).toEqual([MATERIALIZATION_BACKLOG_ALERT, MATERIALIZATION_FAILED_ALERT].sort());
    const failed = active.find((a) => a.code === MATERIALIZATION_FAILED_ALERT)!;
    expect(failed.severity).toBe("error");
    expect(failed.message).toBe(materializationFailedMessage("/a.md", "EACCES: cannot write a.md"));
    expect(failed.detail).toEqual({ path: "/a.md", kind: "write", reason: "EACCES: cannot write a.md" });
    expect(store.db.prepare("SELECT count(*) AS c FROM pending_materializations").get()).toEqual({ c: 1 });
    // A store that takes the write: the row is cleared, both alerts end.
    const cleared = materializePending(store, repoId, new NullDocStore());
    expect(cleared).toEqual(["a.md"]);
    expect(listActiveAlerts(store.db, repoId)).toEqual([]);
  });
});
