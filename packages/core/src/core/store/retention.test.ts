import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "./store.js";
import { ensureRepo } from "../attach.js";
import { observeBatch } from "../../sync/observe.js";
import { sequentialMinter, setIdMinter } from "../ids.js";
import { writeRepoSettings } from "../../sync/settings.js";
import {
  DEFAULT_RETENTION, RetentionPolicyError, ageDays, evaluateRetention, globToRegExp, mergeRetentionPolicy, periodKey, policyFor, retentionPolicy,
} from "./retention.js";

// The retention policy (spec/store §7 "Retention", 15.0): parsing and merging,
// the glob rule, the period keys, and the evaluation over a small store. The
// fixtures under spec/store/cases/retention.json pin the plans; this suite
// covers the pieces the fixtures reach only through their effect.

let store: Store;
let repoId: string;

beforeEach(() => {
  setIdMinter(sequentialMinter());
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", null);
});
afterEach(() => {
  store.close();
  setIdMinter(null);
});

function observe(path: string, source: string, ts: string): void {
  observeBatch(store, repoId, [{ path, content: source }], ts);
}

describe("retention policy", () => {
  it("merges a partial over the defaults and refuses malformed values", () => {
    const p = mergeRetentionPolicy(DEFAULT_RETENTION, { keep_days: 7, ladder: [{ after_days: 90, keep: "one per month" }, { after_days: 7, keep: "one per week" }] });
    expect(p.keep_days).toBe(7);
    expect(p.per_doc_max).toBe(200);
    expect(p.ladder.map((r) => r.after_days)).toEqual([7, 90]); // sorted
    expect(() => mergeRetentionPolicy(DEFAULT_RETENTION, { keep_days: -1 })).toThrow(RetentionPolicyError);
    expect(() => mergeRetentionPolicy(DEFAULT_RETENTION, { ladder: [{ after_days: 1, keep: "two per day" }] })).toThrow(/keep must be one of/);
    expect(() => mergeRetentionPolicy(DEFAULT_RETENTION, { ladder: [{ after_days: 1, keep: "one per day" }, { after_days: 1, keep: "one per week" }] })).toThrow(/share after_days/);
    expect(() => mergeRetentionPolicy(DEFAULT_RETENTION, { bogus: 1 })).toThrow(/unknown key bogus/);
    expect(() => mergeRetentionPolicy(DEFAULT_RETENTION, { overrides: [{ keep_days: 1 }] })).toThrow(/glob/);
  });

  it("reads history.retention from the effective settings", () => {
    writeRepoSettings(store, repoId, { history: { retention: { keep_days: 3 } } });
    expect(retentionPolicy(store, repoId).keep_days).toBe(3);
    expect(retentionPolicy(store, repoId, { keep_days: 1 }).keep_days).toBe(1);
  });

  it("matches override globs against the reference path", () => {
    expect(globToRegExp("/projects/**").test("/projects/a/b.md")).toBe(true);
    expect(globToRegExp("projects/*.md").test("/projects/a.md")).toBe(true);
    expect(globToRegExp("projects/*.md").test("/projects/a/b.md")).toBe(false);
    expect(globToRegExp("/attn/focus.md").test("/attn/focus.md")).toBe(true);
    expect(globToRegExp("/attn/f?cus.md").test("/attn/focus.md")).toBe(true);
    const base = mergeRetentionPolicy(DEFAULT_RETENTION, { overrides: [{ glob: "/attn/**", keep_days: 7 }, { glob: "/**", keep_days: 1 }] });
    expect(policyFor(base, "/attn/x.md").keep_days).toBe(7);
    expect(policyFor(base, "/other.md").keep_days).toBe(1);
    expect(policyFor(base, "/other.md").per_doc_max).toBe(200);
  });

  it("computes ages and period keys in UTC", () => {
    expect(ageDays("2026-01-01T00:00:00.000Z", Date.parse("2026-01-02T00:00:00.000Z"))).toBe(1);
    expect(ageDays("2026-01-01T12:00:00.000Z", Date.parse("2026-01-02T00:00:00.000Z"))).toBe(0);
    expect(periodKey("2026-01-07T23:00:00.000Z", "one per day")).toBe("2026-01-07");
    expect(periodKey("2026-01-07T23:00:00.000Z", "one per month")).toBe("2026-01");
    expect(periodKey("2026-01-07T23:00:00.000Z", "one per year")).toBe("2026");
    // 2026-01-07 is a Wednesday; its ISO week starts Monday the 5th.
    expect(periodKey("2026-01-07T23:00:00.000Z", "one per week")).toBe("2026-01-05");
    expect(periodKey("2026-01-04T23:00:00.000Z", "one per week")).toBe("2025-12-29");
  });
});

describe("evaluateRetention", () => {
  it("keeps the newest of each bucket and the never-prunable set, and costs the plan by the exclusive mark", () => {
    observe("a.md", "# A\n\nOne.\n", "2026-01-01T10:00:00.000Z");
    observe("a.md", "# A\n\nTwo.\n", "2026-01-01T12:00:00.000Z");
    observe("a.md", "# A\n\nThree.\n", "2026-01-02T10:00:00.000Z");
    const plan = evaluateRetention(store, repoId, {
      now: "2026-01-10T00:00:00.000Z",
      policy: mergeRetentionPolicy(DEFAULT_RETENTION, { keep_days: 0, per_doc_max: 0, ladder: [{ after_days: 0, keep: "one per day" }] }),
    });
    expect(plan.docs).toHaveLength(1);
    expect(plan.docs[0]!.keep).toEqual(["r_1", "r_2"]);
    expect(plan.docs[0]!.archive).toEqual(["r_0"]);
    // r_0's own paragraph and its tree node are exclusive; the heading blob is shared with the live revisions.
    expect(plan.docs[0]!.bytes).toBeGreaterThan(0);
    expect(plan.totals).toEqual({ docs: 1, revisions: 3, keep: 2, archive: 1, bytes: plan.docs[0]!.bytes });
  });

  it("the gap below the first rung keeps everything; keep_days is the floor", () => {
    observe("a.md", "# A\n\nOne.\n", "2026-01-01T10:00:00.000Z");
    observe("a.md", "# A\n\nTwo.\n", "2026-01-01T12:00:00.000Z");
    const gap = evaluateRetention(store, repoId, { now: "2026-01-10T00:00:00.000Z", policy: mergeRetentionPolicy(DEFAULT_RETENTION, { keep_days: 0, per_doc_max: 0, ladder: [{ after_days: 30, keep: "one per day" }] }) });
    expect(gap.totals.archive).toBe(0);
    const young = evaluateRetention(store, repoId, { now: "2026-01-10T00:00:00.000Z", policy: mergeRetentionPolicy(DEFAULT_RETENTION, { keep_days: 30, per_doc_max: 0, ladder: [{ after_days: 0, keep: "one per day" }] }) });
    expect(young.totals.archive).toBe(0);
    const empty = evaluateRetention(store, repoId, { now: "2026-01-10T00:00:00.000Z", policy: mergeRetentionPolicy(DEFAULT_RETENTION, { keep_days: 0, per_doc_max: 0, ladder: [] }) });
    expect(empty.totals.archive).toBe(0);
  });

  it("is deterministic: the same store, policy and clock give the same plan", () => {
    observe("a.md", "# A\n\nOne.\n", "2026-01-01T10:00:00.000Z");
    observe("a.md", "# A\n\nTwo.\n", "2026-01-01T12:00:00.000Z");
    const opts = { now: "2026-01-10T00:00:00.000Z", policy: mergeRetentionPolicy(DEFAULT_RETENTION, { keep_days: 0, per_doc_max: 0, ladder: [{ after_days: 0, keep: "one per day" }] }) };
    expect(evaluateRetention(store, repoId, opts)).toEqual(evaluateRetention(store, repoId, opts));
  });
});
