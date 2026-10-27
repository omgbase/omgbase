import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "./store.js";
import { ensureRepo } from "../attach.js";
import { ingestFile } from "../ingest.js";
import { sha256 } from "../hash.js";
import { pinClock } from "../clock.js";
import { writeRepoSettings, writeWorkspaceSettings } from "../../sync/settings.js";
import { capabilityStates } from "../../sync/capability-state.js";
import { IdClaims } from "../capabilities/claims.js";
import { HistoryRecorderImpl } from "../capabilities/history.js";
import { CapabilityUnavailable, HISTORY_WRITER_REQUIRED_MESSAGE } from "../capabilities/errors.js";
import { listActiveAlerts } from "./alerts.js";
import { bindCapabilities } from "../capabilities/registry.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalConfigJson, configHash, coverageFrom, readCapabilities, readCapability, refreshSemanticManifest, requireWriter,
  HISTORY_DATA_V, HISTORY_INTERFACE_V, SEMANTIC_DATA_V, SEMANTIC_INTERFACE_V, WRITER_REFUSED_ALERT, WRITER_REFUSED_MESSAGE,
} from "./manifest.js";

// The capability manifest (spec/store §3.1 `capabilities`, 17.0 — modular-core
// Phase 3e-ii; phase-1-contracts §1.5, §1.14, §1.16 step 11, resolutions 1 and
// 17): the rows `ensure_repo` writes, the semantic row following the settings,
// `version.capabilities` read from the table, the `writer_requires` refusal and
// a 17 database that lacks the tables finishing the step on open.

const T0 = "2026-09-26T10:00:00.000Z";
const T1 = "2026-09-26T10:05:00.000Z";
const T2 = "2026-09-26T10:10:00.000Z";

let store: Store;
let restore: (() => void) | null = null;

beforeEach(() => {
  restore = pinClock(T0);
  store = new Store({ path: ":memory:" });
});
afterEach(() => {
  store.close();
  restore?.();
  restore = null;
});

describe("the rows ensure_repo writes", () => {
  it("history: enabled, interface/data 1, config {} and its hash, one open interval from the repo's birth, writer_requires 1", () => {
    const repoId = ensureRepo(store, "fixture", null);
    const row = readCapability(store.db, repoId, "history")!;
    expect(row).toMatchObject({ capability: "history", state: "enabled", interface_v: HISTORY_INTERFACE_V, data_v: HISTORY_DATA_V, config: {}, writer_requires: true, updated_at: T0 });
    expect(row.coverage).toEqual([{ from: T0, to: null }]);
    expect(row.config_hash.equals(sha256("{}"))).toBe(true);
    expect(coverageFrom(row)).toBe(T0);
  });

  it("semantic: disabled with no coverage when no provider is configured; enabled with { model, dim } when one is (resolution 1)", () => {
    const a = ensureRepo(store, "plain", null);
    expect(readCapability(store.db, a, "semantic")).toMatchObject({ state: "disabled", coverage: [], config: {}, interface_v: SEMANTIC_INTERFACE_V, data_v: SEMANTIC_DATA_V, writer_requires: false });
    writeWorkspaceSettings(store, { embedding: { provider: "omgbase-embedder", model: "gte-base", dim: 768 } });
    const b = ensureRepo(store, "embedded", null);
    const row = readCapability(store.db, b, "semantic")!;
    expect(row.state).toBe("enabled");
    expect(row.config).toEqual({ model: "gte-base", dim: 768 });
    expect(row.config_hash.equals(configHash({ dim: 768, model: "gte-base" }))).toBe(true);
    expect(row.coverage).toEqual([{ from: T0, to: null }]);
  });

  it("a repository with no row reads as disabled with no coverage (rule 1)", () => {
    expect(readCapability(store.db, "rp_nobody", "semantic")).toBeNull();
    expect(coverageFrom(null)).toBeNull();
  });
});

describe("the semantic row follows the settings until the Phase 4 verbs", () => {
  it("a workspace write opens an interval, a removal closes it, a config change moves the hash only", () => {
    const repoId = ensureRepo(store, "fixture", null);
    restore?.(); restore = pinClock(T1);
    writeWorkspaceSettings(store, { embedding: { provider: "omgbase-embedder", model: "m1" } });
    let row = readCapability(store.db, repoId, "semantic")!;
    expect(row.state).toBe("enabled");
    expect(row.coverage).toEqual([{ from: T1, to: null }]);
    expect(row.config).toEqual({ model: "m1" });
    expect(row.updated_at).toBe(T1);

    restore?.(); restore = pinClock(T2);
    writeWorkspaceSettings(store, { embedding: { provider: "omgbase-embedder", model: "m2" } });
    row = readCapability(store.db, repoId, "semantic")!;
    expect(row.state).toBe("enabled");
    expect(row.coverage).toEqual([{ from: T1, to: null }]); // a model switch is a rebuild, not a boundary
    expect(row.config).toEqual({ model: "m2" });
    expect(row.config_hash.equals(configHash({ model: "m2" }))).toBe(true);

    writeWorkspaceSettings(store, {});
    row = readCapability(store.db, repoId, "semantic")!;
    expect(row.state).toBe("disabled");
    expect(row.coverage).toEqual([{ from: T1, to: T2 }]);
    expect(row.config).toEqual({});
  });

  it("a repo-layer write touches that repository alone; an unchanged write leaves updated_at alone", () => {
    const a = ensureRepo(store, "a", null);
    const b = ensureRepo(store, "b", null);
    restore?.(); restore = pinClock(T1);
    writeRepoSettings(store, a, { embedding: { provider: "x" } });
    expect(readCapability(store.db, a, "semantic")!.state).toBe("enabled");
    expect(readCapability(store.db, b, "semantic")!.state).toBe("disabled");
    expect(readCapability(store.db, b, "semantic")!.updated_at).toBe(T0);
    restore?.(); restore = pinClock(T2);
    expect(refreshSemanticManifest(store.db, a, T2).updated_at).toBe(T1); // nothing changed: not touched
  });

  it("version.capabilities is the table's rendering: enabled/enabled with a provider, semantic disabled without one; coverage_from, writer_requires and model ride along (Phase 4a)", () => {
    const repoId = ensureRepo(store, "fixture", null);
    const history = { state: "enabled", provider: "native", coverage_from: T0, writer_requires: true, completeness: "every", remote: null };
    expect(capabilityStates(store, repoId)).toEqual({ history, semantic: { state: "disabled", model: null } });
    writeWorkspaceSettings(store, { embedding: { provider: "omgbase-embedder", model: "gte-base" } });
    expect(capabilityStates(store, repoId)).toEqual({ history, semantic: { state: "enabled", model: "gte-base" } });
    expect(capabilityStates(store, repoId, { provider: "omgbase-embedder", reason: "ENOENT" })).toEqual({ history, semantic: { state: "unavailable", model: "gte-base" } });
    writeWorkspaceSettings(store, { embedding: {} });
    expect(capabilityStates(store, repoId)).toEqual({ history, semantic: { state: "disabled", model: null } });
    // Without a repository there is no row: the workspace layer's setting answers, as Phase 2 did.
    expect(capabilityStates(store, null)).toEqual({ history: { state: "enabled", provider: "native", coverage_from: null, writer_requires: false, completeness: "every", remote: null }, semantic: { state: "disabled", model: null } });
  });
});

describe("writer_requires (resolution 17)", () => {
  it("passes with the recorder present (every 17.0 composition) and clears a standing writer_refused alert", () => {
    const repoId = ensureRepo(store, "fixture", null);
    expect(() => requireWriter(store.db, repoId, T1)).not.toThrow();
    ingestFile(store, repoId, "a.md", "# A\n\nbody\n");
    expect(listActiveAlerts(store.db, repoId)).toEqual([]);
  });

  it("refuses a writer without the history module on a repository that requires capture, and raises writer_refused", () => {
    // The core-only composition (Phase 4a). A repository IT creates starts disabled; this one was enabled by a full build.
    const bare = new Store({ path: ":memory:", capabilities: (s) => ({ history: null, semantic: null, claims: new IdClaims(s), providers: {} }) });
    try {
      const repoId = ensureRepo(bare, "fixture", null);
      expect(readCapability(bare.db, repoId, "history")!.state).toBe("disabled");
      bare.db.prepare("UPDATE capabilities SET state = 'enabled', writer_requires = 1, coverage = ? WHERE repo_id = ? AND capability = 'history'").run(JSON.stringify([{ from: T0, to: null }]), repoId);
      expect(readCapability(bare.db, repoId, "history")!.writer_requires).toBe(true);
      let err: unknown;
      try {
        requireWriter(bare.db, repoId, T1);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CapabilityUnavailable);
      const cu = err as CapabilityUnavailable;
      expect(cu.capability).toBe("history");
      expect(cu.state).toBe("unavailable");
      expect(cu.retriable).toBe(true);
      expect(cu.message).toBe(HISTORY_WRITER_REQUIRED_MESSAGE);
      expect(cu.data()).toEqual({ capability: "history", state: "unavailable" });
      expect(listActiveAlerts(bare.db, repoId)).toEqual([{ code: WRITER_REFUSED_ALERT, severity: "error", message: WRITER_REFUSED_MESSAGE, since: T1, detail: { capability: "history" } }]);
      // The same store writing through an engine that carries the recorder passes and clears the alert.
      const withRecorder = { history: new HistoryRecorderImpl(bare), semantic: null, claims: bare.capabilities.claims, providers: {} };
      (bare as { capabilities: unknown }).capabilities = withRecorder;
      bindCapabilities(bare.db, withRecorder);
      expect(() => requireWriter(bare.db, repoId, T2)).not.toThrow();
      expect(listActiveAlerts(bare.db, repoId)).toEqual([]);
    } finally {
      bare.close();
    }
  });

  it("a repository whose manifest does not require capture, or whose capture is off, lets a recorder-less writer through", () => {
    const bare = new Store({ path: ":memory:", capabilities: (s) => ({ history: null, semantic: null, claims: new IdClaims(s), providers: {} }) });
    try {
      const repoId = ensureRepo(bare, "fixture", null);
      // Created by a core-only build: `disabled`, no coverage, writer_requires 0 (spec/store §3.1) — and it writes.
      expect(readCapability(bare.db, repoId, "history")).toMatchObject({ state: "disabled", coverage: [], writer_requires: false });
      expect(() => requireWriter(bare.db, repoId, T1)).not.toThrow();
      const r = ingestFile(bare, repoId, "a.md", "# A\n\nbody\n", { ts: T1 });
      expect(r.converged).toBe(true);
      expect(bare.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'revisions'").get()).toBeUndefined();
      // Enabled best-effort (writer_requires 0): a recorder-less writer still passes.
      bare.db.prepare("UPDATE capabilities SET state = 'enabled', writer_requires = 0, coverage = ? WHERE repo_id = ? AND capability = 'history'").run(JSON.stringify([{ from: T1, to: null }]), repoId);
      expect(() => requireWriter(bare.db, repoId, T2)).not.toThrow();
    } finally {
      bare.close();
    }
  });
});

describe("migration 17 finishes the manifest on open", () => {
  it("a 17 database without the two tables gets them on open, the history row anchored on the repository's first commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "omgbase-manifest-"));
    const path = join(dir, "db.sqlite");
    try {
      const first = new Store({ path });
      const repoId = ensureRepo(first, "fixture", null);
      ingestFile(first, repoId, "a.md", "# A\n\nbody\n", { ts: T1 });
      first.db.exec("DROP TABLE capabilities; DROP TABLE alerts;");
      first.close();
      const reopened = new Store({ path });
      try {
        const rows = readCapabilities(reopened.db, repoId);
        expect(rows.history).toMatchObject({ state: "enabled", writer_requires: true, coverage: [{ from: T1, to: null }], updated_at: T0 });
        expect(rows.semantic).toMatchObject({ state: "disabled", coverage: [] });
        expect(reopened.db.prepare("SELECT count(*) AS c FROM alerts").get()).toEqual({ c: 0 });
        // Idempotent: a second open leaves the rows alone.
        const before = reopened.db.prepare("SELECT * FROM capabilities ORDER BY capability").all();
        reopened.close();
        const third = new Store({ path });
        expect(third.db.prepare("SELECT * FROM capabilities ORDER BY capability").all()).toEqual(before);
        third.close();
      } finally {
        try { reopened.close(); } catch { /* closed above */ }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the fingerprint", () => {
  it("canonical JSON sorts keys at every level; the hash is sha256 of it", () => {
    expect(canonicalConfigJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: "x" } })).toBe('{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
    expect(configHash({ model: "m", dim: 3 }).equals(sha256('{"dim":3,"model":"m"}'))).toBe(true);
  });
});
