// The pure side of task checkboxes (src/lib/tasks.ts): the marker, the one
// CAS-pinned effect, the gate reasons and the moved-on codes. The undo of a
// toggle is `@omgbase/client`'s `taskCheckCommand` on the shared `CommandLog`,
// tested there.
import { describe, expect, it } from "vitest";
import { OmgError, applyArgs } from "../src/lib/mcp-client.ts";
import { MOVED_ON_MESSAGE, isMovedOn, setCheckedEffect, taskDisabledReason, taskMarker } from "../src/lib/tasks.ts";
import { ScriptedCaller } from "./scripted.ts";

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
    expect(isMovedOn(new OmgError("stale_expectation", "x", { data: { current: { _hash: "h9" } }, retriable: true }))).toBe(true);
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
