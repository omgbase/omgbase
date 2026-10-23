// The pure side of task checkboxes (src/lib/tasks.ts): the marker, the one
// CAS-pinned effect, the gate reasons, the moved-on codes, and the undo log —
// above all that a compensation is REFUSED when the block's current hash is not
// the one the toggle left.
import { describe, expect, it } from "vitest";
import { OmgError, applyArgs } from "../src/lib/mcp-client.ts";
import {
  EMPTY_LOG, LOG_CAP, MOVED_ON_MESSAGE, afterCompensation, compensation, isMovedOn, nextToggle, pushToggle, setCheckedEffect, taskDisabledReason, taskMarker, toggleLabel,
  type ToggleRecord,
} from "../src/lib/tasks.ts";
import { receiptOf } from "../src/lib/writes.ts";
import { ScriptedCaller } from "./scripted.ts";

const receipt = receiptOf({ plan_id: "p", commit: "c_31", revisions: [{ _id: "d_7", _path: "processes/calcination.md", _hash: "f1" }], new_ids: {}, committed: true, summary: ["set _attrs.checked = true on b_160"] });

function rec(over: Partial<ToggleRecord> = {}): ToggleRecord {
  return { blockId: "b_160", path: "/processes/calcination.md", from: false, to: true, hashBefore: "h0", hashAfter: "h1", receipt, ...over };
}

describe("the marker", () => {
  it("recognises the GFM task marker at the start of the text, followed by whitespace, in either case", () => {
    expect(taskMarker("[ ] Repeat with copper")).toEqual({ checked: false, length: 4 });
    expect(taskMarker("[x] Verify the weight gain")).toEqual({ checked: true, length: 4 });
    expect(taskMarker("[X] Confirm")).toEqual({ checked: true, length: 4 });
    expect(taskMarker("[x]\ttabbed")).toEqual({ checked: true, length: 4 });
  });
  it("is not fooled by a link, a missing space, a different bracket content or a marker later in the text", () => {
    expect(taskMarker("[x](https://example.com) a link")).toBeNull();
    expect(taskMarker("[ ]no space")).toBeNull();
    expect(taskMarker("[y] nope")).toBeNull();
    expect(taskMarker("[  ] two spaces")).toBeNull();
    expect(taskMarker("done [x] later")).toBeNull();
    expect(taskMarker("")).toBeNull();
  });
});

describe("the effect", () => {
  it("is set _attrs.checked on a block target, pinned to the block's hash (spec/mutate §11.2, §1.2)", () => {
    expect(setCheckedEffect("b_160", true, "abc")).toEqual({ op: "set", target: { kind: "block", _id: "b_160" }, field: "_attrs.checked", value: true, expect: { content_hash: "abc" } });
    expect(setCheckedEffect("b_160", false, "abc").value).toBe(false);
  });
  it("goes out as ONE apply { effects, reason, repo? } over the minimal profile", async () => {
    const s = new ScriptedCaller({ apply: (a) => ({ plan_id: "p", commit: "c_31", revisions: [], new_ids: {}, committed: true, summary: [], echoed: a.effects }) });
    const effect = setCheckedEffect("b_160", true, "h0");
    await s.call("apply", applyArgs([effect], { reason: "repo-explorer task toggle", repo: null }));
    expect(s.calls).toEqual([{ name: "apply", args: { effects: [effect], reason: "repo-explorer task toggle" } }]);
    expect(applyArgs([effect], { repo: "alchemy" })).toEqual({ effects: [effect], repo: "alchemy" });
  });
  it("moved-on: stale_expectation (the kernel's CAS), stale_plan and plan_mismatch; nothing else", () => {
    expect(isMovedOn(new OmgError("stale_expectation", "x", { current: { _hash: "h9" } }, true))).toBe(true);
    expect(isMovedOn(new OmgError("stale_plan", "x"))).toBe(true);
    expect(isMovedOn(new OmgError("plan_mismatch", "x"))).toBe(true);
    expect(isMovedOn(new OmgError("filter_invalid", "x"))).toBe(false);
    expect(isMovedOn(new Error("network"))).toBe(false);
    expect(isMovedOn(null)).toBe(false);
    expect(MOVED_ON_MESSAGE).toMatch(/refreshed; try again/);
  });
});

describe("why a box is disabled", () => {
  it("read-only servers first, then an unpaired item, then an unverified one; a verified item on a writable server is enabled", () => {
    expect(taskDisabledReason({ canApply: false, anchor: "verified" })).toMatch(/does not list `apply`/);
    expect(taskDisabledReason({ canApply: false, anchor: "none" })).toMatch(/does not list `apply`/);
    expect(taskDisabledReason({ canApply: true, anchor: "none" })).toMatch(/no block anchor/);
    expect(taskDisabledReason({ canApply: true, anchor: "unverified" })).toMatch(/could not be verified/);
    expect(taskDisabledReason({ canApply: true, anchor: "verified" })).toBeNull();
  });
});

describe("the undo log", () => {
  it("pushToggle appends, clears the redo stack and caps the history", () => {
    let log = pushToggle(EMPTY_LOG, rec({ blockId: "b_1" }));
    log = pushToggle(log, rec({ blockId: "b_2" }));
    expect(log.done.map((r) => r.blockId)).toEqual(["b_1", "b_2"]);
    expect(nextToggle(log, "undo")?.blockId).toBe("b_2");
    expect(nextToggle(log, "redo")).toBeNull();
    const undone = afterCompensation(log, log.done[1]!, "undo", "h0");
    expect(nextToggle(undone, "redo")?.blockId).toBe("b_2");
    expect(pushToggle(undone, rec({ blockId: "b_3" })).undone).toEqual([]);
    let big = EMPTY_LOG;
    for (let i = 0; i < LOG_CAP + 5; i++) big = pushToggle(big, rec({ blockId: `b_${i}` }));
    expect(big.done).toHaveLength(LOG_CAP);
    expect(big.done[0]!.blockId).toBe("b_5");
  });
  it("compensation: undo expects hashAfter and sets `from`; redo expects hashBefore and sets `to`", () => {
    const undo = compensation(rec(), "h1", "undo");
    expect(undo).toEqual({ ok: true, value: false, expectedHash: "h1", effect: setCheckedEffect("b_160", false, "h1") });
    const redo = compensation(rec(), "h0", "redo");
    expect(redo).toEqual({ ok: true, value: true, expectedHash: "h0", effect: setCheckedEffect("b_160", true, "h0") });
  });
  it("REFUSES when the block's current hash is not the one the toggle left, or the block is gone — never overwrites", () => {
    const changed = compensation(rec(), "h7", "undo");
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.reason).toMatch(/cannot undo: block b_160 in \/processes\/calcination\.md changed since the toggle \(expected hash h1…, now h7…\) — not overwriting/);
    const gone = compensation(rec(), undefined, "undo");
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.reason).toMatch(/no longer in \/processes\/calcination\.md/);
    // Redo checks against hashBefore: the undo's own result counts as "unchanged", a later edit does not.
    expect(compensation(rec(), "h1", "redo").ok).toBe(false);
    expect(compensation(rec(), "h0", "redo").ok).toBe(true);
  });
  it("afterCompensation moves the record and keeps the hash the write left in the slot the other direction expects", () => {
    const r = rec();
    const log = pushToggle(EMPTY_LOG, r);
    // Undo left the block at h0b (e.g. `[X]` normalised to `[x]`): redo must expect h0b, not the original h0.
    const undone = afterCompensation(log, r, "undo", "h0b");
    expect(undone.done).toEqual([]);
    expect(undone.undone).toEqual([{ ...r, hashBefore: "h0b" }]);
    expect(compensation(undone.undone[0]!, "h0b", "redo").ok).toBe(true);
    expect(compensation(undone.undone[0]!, "h0", "redo").ok).toBe(false);
    const redone = afterCompensation(undone, undone.undone[0]!, "redo", "h1b");
    expect(redone.undone).toEqual([]);
    expect(redone.done).toEqual([{ ...r, hashBefore: "h0b", hashAfter: "h1b" }]);
  });
  it("toggleLabel says what the compensation would do", () => {
    expect(toggleLabel(rec(), "undo")).toBe("undo: uncheck b_160 in /processes/calcination.md");
    expect(toggleLabel(rec(), "redo")).toBe("redo: check b_160 in /processes/calcination.md");
    expect(toggleLabel(null, "undo")).toBeNull();
  });
});
