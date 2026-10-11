import { describe, expect, it } from "vitest";
import {
  RECENT_QUERY, advanceCursor, byline, diffLineKind, diffStats, entryFromDigest, formatTime, latestPair, pairForCommit, pollMs, prependDigests, recentFromHits, startCursor,
  type Digest, type DocVersion, type FeedEntry,
} from "../src/lib/feed.ts";

const digest = (seq: number, commit = `c_${seq}`, revisions: Digest["revisions"] = [{ doc: "d_a", path: "/notes/alpha.md", contentHash: "aa" }]): Digest => ({
  commit, seq, ts: `2026-10-10T12:00:0${seq % 10}Z`, origin: "api", actor: "agent:mcp", summary: `docs_set_meta ${revisions.map((r) => r.path).join(", ")}`, revisions,
});
const version = (i: number, commit: string): DocVersion => ({ rev: `r_${i}`, seq: i, commit, ts: "2026-10-10T12:00:00Z", origin: "observed", actor: null, contentHash: `h${i}`, isCurrent: false });

describe("the cursor", () => {
  it("starts at the repo's head and follows the page's cursor", () => {
    expect(startCursor({ head: 42 })).toBe(42);
    expect(advanceCursor({ cursor: 45, head: 45 })).toEqual({ cursor: 45, reset: false });
    expect(advanceCursor({ cursor: 42, head: 45 })).toEqual({ cursor: 42, reset: false }); // an empty page echoes the cursor
  });
  it("restarts from the head when the cursor belongs to another repo or server", () => {
    expect(advanceCursor({ cursor: 900, head: 45 })).toEqual({ cursor: 45, reset: true });
  });
});

describe("digests → entries", () => {
  it("keeps the digest's identity, roots every path and reads the byline", () => {
    const e = entryFromDigest(digest(7, "c_7", [{ doc: "d_a", path: "notes/alpha.md", contentHash: "aa" }, { doc: "d_b", path: "/notes/beta.md", contentHash: "bb" }]));
    expect(e).toEqual({
      key: "c_7", seq: 7, ts: "2026-10-10T12:00:07Z", origin: "api", actor: "agent:mcp", summary: "docs_set_meta notes/alpha.md, /notes/beta.md",
      changes: [{ doc: "d_a", path: "/notes/alpha.md", contentHash: "aa" }, { doc: "d_b", path: "/notes/beta.md", contentHash: "bb" }],
    });
    expect(byline(e)).toBe("api · agent:mcp");
    expect(byline({ origin: "observed", actor: null })).toBe("observed");
  });
  it("prepends a page newest-first and never repeats a commit", () => {
    const shown: FeedEntry[] = [entryFromDigest(digest(2)), entryFromDigest(digest(1))];
    const next = prependDigests(shown, [digest(2), digest(3), digest(4)]);
    expect(next.map((e) => e.seq)).toEqual([4, 3, 2, 1]);
    expect(prependDigests([], [])).toEqual([]);
    expect(prependDigests(shown, [digest(1), digest(2)])).toEqual(shown);
  });
  it("carries a deletion or move digest with no revisions as an entry without changes", () => {
    const e = entryFromDigest({ ...digest(9, "c_9", []), summary: "delete /notes/old.md" });
    expect(e.changes).toEqual([]);
    expect(e.summary).toBe("delete /notes/old.md");
  });
});

describe("which revisions to diff", () => {
  const versions = [version(1, "c_1"), version(2, "c_2"), version(3, "c_3")];
  it("latestPair: the last two versions, or 'created' for a single one", () => {
    expect(latestPair(versions)).toEqual({ kind: "changed", from: "r_2", to: "r_3" });
    expect(latestPair([version(1, "c_1")])).toEqual({ kind: "created", rev: "r_1" });
    expect(latestPair([])).toBeNull();
  });
  it("pairForCommit: the commit's version against its predecessor; 'created' for the first; null when the commit wrote none", () => {
    expect(pairForCommit(versions, "c_2")).toEqual({ kind: "changed", from: "r_1", to: "r_2" });
    expect(pairForCommit(versions, "c_3")).toEqual({ kind: "changed", from: "r_2", to: "r_3" });
    expect(pairForCommit(versions, "c_1")).toEqual({ kind: "created", rev: "r_1" });
    expect(pairForCommit(versions, "c_move")).toBeNull();
  });
});

describe("recent documents", () => {
  it("asks for the most recently updated documents", () => {
    expect(RECENT_QUERY).toBe("select $path, $title, $updated_at from docs order by $updated_at desc limit 25");
  });
  it("reads hits under the 3.0 envelope ($id/$path) and the 2.x one (id/path) alike", () => {
    const v3 = { $id: "d_a", $path: "/notes/alpha.md", $title: "Alpha", $updated_at: "2026-10-10T12:00:00Z" };
    const v2 = { id: "d_a", path: "/notes/alpha.md", $path: "/notes/alpha.md", $title: "Alpha", $updated_at: "2026-10-10T12:00:00Z" };
    const expected = [{ id: "d_a", path: "/notes/alpha.md", title: "Alpha", updatedAt: "2026-10-10T12:00:00Z" }];
    expect(recentFromHits([v3])).toEqual(expected);
    expect(recentFromHits([v2])).toEqual(expected);
  });
  it("roots a bare path, drops an empty title, skips a hit without a path", () => {
    expect(recentFromHits([{ id: "d_b", path: "notes/beta.md", $title: "  ", $updated_at: null }, { $id: "d_x" }]))
      .toEqual([{ id: "d_b", path: "/notes/beta.md", title: null, updatedAt: null }]);
  });
});

describe("rendering helpers", () => {
  it("classifies diff lines and counts them", () => {
    const diff = "@@ -1,3 +1,4 @@\n title: Alpha\n-status: active\n+status: done\n+owner: ada\n # Alpha";
    expect(diff.split("\n").map(diffLineKind)).toEqual(["hunk", "ctx", "del", "add", "add", "ctx"]);
    expect(diffStats(diff)).toEqual({ added: 2, removed: 1 });
    expect(diffStats("")).toEqual({ added: 0, removed: 0 });
    expect(diffLineKind("--- a line that starts with dashes")).toBe("del"); // no file headers exist in diff_unified output
  });
  it("formats times relative to today and leaves junk alone", () => {
    const now = new Date(2026, 9, 10, 15, 0, 0);
    const today = new Date(2026, 9, 10, 9, 5, 7).toISOString();
    const yesterday = new Date(2026, 9, 9, 23, 59, 0).toISOString();
    expect(formatTime(today, now)).toBe("09:05:07");
    expect(formatTime(yesterday, now)).toBe("2026-10-09 23:59");
    expect(formatTime("not a date", now)).toBe("not a date");
    expect(formatTime(null, now)).toBe("");
  });
  it("turns the interval input into milliseconds, with bounds", () => {
    expect(pollMs("2")).toBe(2000);
    expect(pollMs(5)).toBe(5000);
    expect(pollMs("0")).toBe(2000);
    expect(pollMs("abc")).toBe(2000);
    expect(pollMs(null, 3000)).toBe(3000);
    expect(pollMs("4000")).toBe(2000);
  });
});
