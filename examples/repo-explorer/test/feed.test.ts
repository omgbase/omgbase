import { describe, expect, it } from "vitest";
import { FEED_CAP, advanceCursor, byline, changesArgs, changesOf, entryFromDigest, fetchChanges, formatTime, pollMs, prependDigests, startCursor, touchedPaths, type Digest } from "../src/lib/feed.ts";
import { ScriptedCaller } from "./scripted.ts";

const digest = (seq: number, revisions: Digest["revisions"] = [{ id: "d_a", path: "/notes/alpha.md", hash: "aa" }]): Digest => ({
  commit: `c_${seq}`, seq, ts: `2026-10-14T12:00:0${seq % 10}Z`, origin: "api", actor: "agent:mcp", summary: `api(agent:mcp): ${revisions.map((r) => r.path).join(", ")}`, revisions,
});

describe("changes_since", () => {
  it("reads a page as the server spells it (5.0: a revision is { _id, _path, _hash }; the digest's keys are roles), rooting every revision path", () => {
    const page = changesOf({ digests: [{ commit: "c_1", seq: 1, ts: "t", origin: "observed", actor: null, summary: "observed: /index.md — 31 inserted", revisions: [{ _id: "d_0", _path: "index.md", _hash: "h" }] }], cursor: 1, truncated: true, head: 20 });
    expect(page.digests[0]).toEqual({ commit: "c_1", seq: 1, ts: "t", origin: "observed", actor: null, summary: "observed: /index.md — 31 inserted", revisions: [{ id: "d_0", path: "/index.md", hash: "h" }] });
    expect(page).toMatchObject({ cursor: 1, truncated: true, head: 20 });
  });
  it("the cursor starts at the head and follows the page; beyond the head it restarts", () => {
    expect(startCursor({ head: 42 })).toBe(42);
    expect(advanceCursor({ cursor: 45, head: 45 })).toEqual({ cursor: 45, reset: false });
    expect(advanceCursor({ cursor: 900, head: 45 })).toEqual({ cursor: 45, reset: true });
  });
  it("spells the call", () => {
    expect(changesArgs(null, null, 1)).toEqual({ limit: 1 });
    expect(changesArgs("alchemy", 20, 50)).toEqual({ limit: 50, cursor: 20, repo: "alchemy" });
  });
  it("fetchChanges over a scripted minimal server", async () => {
    const s = new ScriptedCaller({ changes_since: () => ({ digests: [], cursor: 22, truncated: false, head: 22 }) });
    expect(await fetchChanges(s, null, 20)).toEqual({ digests: [], cursor: 22, truncated: false, head: 22 });
    expect(s.calls).toEqual([{ name: "changes_since", args: { limit: 50, cursor: 20 } }]);
  });
});

describe("entries", () => {
  it("entryFromDigest keeps identity and the documents touched; a deletion has none", () => {
    expect(entryFromDigest(digest(7))).toEqual({ key: "c_7", seq: 7, ts: "2026-10-14T12:00:07Z", origin: "api", actor: "agent:mcp", summary: "api(agent:mcp): /notes/alpha.md", docs: [{ id: "d_a", path: "/notes/alpha.md" }] });
    expect(entryFromDigest(digest(8, [])).docs).toEqual([]);
    expect(byline({ origin: "api", actor: "agent:mcp" })).toBe("api · agent:mcp");
    expect(byline({ origin: "observed", actor: null })).toBe("observed");
  });
  it("prependDigests: newest first, no repeated commit, capped", () => {
    const shown = [entryFromDigest(digest(2)), entryFromDigest(digest(1))];
    expect(prependDigests(shown, [digest(2), digest(3), digest(4)]).map((e) => e.seq)).toEqual([4, 3, 2, 1]);
    expect(prependDigests(shown, [digest(1)])).toEqual(shown);
    const many = Array.from({ length: FEED_CAP + 5 }, (_, i) => digest(i + 1));
    expect(prependDigests([], many)).toHaveLength(FEED_CAP);
  });
  it("touchedPaths dedups the documents of a page", () => {
    expect(touchedPaths([digest(1), digest(2, [{ id: "d_b", path: "/b.md", hash: "b" }, { id: "d_a", path: "/notes/alpha.md", hash: "a2" }]), digest(3, [])])).toEqual(["/notes/alpha.md", "/b.md"]);
  });
  it("formatTime and pollMs", () => {
    const now = new Date(2026, 9, 14, 15, 0, 0);
    expect(formatTime(new Date(2026, 9, 14, 9, 5, 7).toISOString(), now)).toBe("09:05:07");
    expect(formatTime(new Date(2026, 9, 13, 23, 59, 0).toISOString(), now)).toBe("2026-10-13 23:59");
    expect(formatTime("junk", now)).toBe("junk");
    expect(formatTime(null, now)).toBe("");
    expect(pollMs("2")).toBe(2000);
    expect(pollMs("0")).toBe(3000);
    expect(pollMs(null, 5000)).toBe(5000);
  });
});
