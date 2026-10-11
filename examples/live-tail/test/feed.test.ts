import { describe, expect, it } from "vitest";
import {
  FRAME_AFTER, FRAME_BEFORE, RECENT_QUERY, advanceCursor, byline, createdDiff, diffLineKind, diffStats, digestPaths, entryFromDigest, filterStateAfter, formatTime, frameFor, hiddenLine, latestPair, matchQuery, pairForCommit, partitionByFilter, pollMs, prependDigests, recentFromHits, recentQuery, startCursor, titlesByPath,
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
  it("keeps the digest's identity, roots every path, reads the byline; without a lookup every title is null", () => {
    const e = entryFromDigest(digest(7, "c_7", [{ doc: "d_a", path: "notes/alpha.md", contentHash: "aa" }, { doc: "d_b", path: "/notes/beta.md", contentHash: "bb" }]));
    expect(e).toEqual({
      key: "c_7", seq: 7, ts: "2026-10-10T12:00:07Z", origin: "api", actor: "agent:mcp", summary: "docs_set_meta notes/alpha.md, /notes/beta.md",
      changes: [{ doc: "d_a", path: "/notes/alpha.md", title: null, contentHash: "aa" }, { doc: "d_b", path: "/notes/beta.md", title: null, contentHash: "bb" }],
    });
    expect(byline(e)).toBe("api · agent:mcp");
    expect(byline({ origin: "observed", actor: null })).toBe("observed");
  });
  it("gives each change its title from the poll's lookup, by rooted path; a document the lookup lacks (deleted, moved away) keeps the path alone", () => {
    const titles = new Map([["/notes/alpha.md", "Alpha"], ["/notes/beta.md", null]]);
    const e = entryFromDigest(digest(7, "c_7", [
      { doc: "d_a", path: "notes/alpha.md", contentHash: "aa" }, { doc: "d_b", path: "/notes/beta.md", contentHash: "bb" }, { doc: "d_g", path: "/notes/gone.md", contentHash: "gg" },
    ]), titles);
    expect(e.changes.map((c) => [c.path, c.title])).toEqual([["/notes/alpha.md", "Alpha"], ["/notes/beta.md", null], ["/notes/gone.md", null]]);
    expect(prependDigests([], [digest(1)], titles)[0]!.changes[0]!.title).toBe("Alpha");
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

describe("the filter", () => {
  it("recentQuery: the filter becomes the where clause; none or blank leaves the plain query (no empty where)", () => {
    expect(recentQuery('status == "active"')).toBe('select $path, $title, $updated_at from docs where status == "active" order by $updated_at desc limit 25');
    expect(recentQuery("  a == 1 or b == 2  ")).toBe("select $path, $title, $updated_at from docs where a == 1 or b == 2 order by $updated_at desc limit 25");
    expect(recentQuery("")).toBe("select $path, $title, $updated_at from docs order by $updated_at desc limit 25");
    expect(recentQuery("   ")).toBe(RECENT_QUERY);
    expect(recentQuery()).toBe(RECENT_QUERY);
  });
  it("frameFor, filled (idle or editing): three lines, the filter in the hole on the where line; the same tokens as recentQuery", () => {
    for (const editing of [false, true]) {
      const f = frameFor('status == "active"', { editing });
      expect(f.text).toBe('select $path, $title, $updated_at from docs\nwhere status == "active"\norder by $updated_at desc limit 25');
      expect(f.where).toBe(true);
      expect(f.text.split("\n")).toHaveLength(3);
      expect(f.text.replace(/\n/g, " ")).toBe(recentQuery('status == "active"'));
      expect(f.text.slice(f.hole.from, f.hole.to)).toBe('status == "active"');
      expect(f.text.slice(0, f.hole.from)).toBe(FRAME_BEFORE);
      expect(f.text.slice(f.hole.to)).toBe(FRAME_AFTER);
      expect(f.text.split("\n")[1]).toBe('where status == "active"'); // the hole lives on the second line alone
    }
    const astral = frameFor('$title == "𝒜"'); // offsets are UTF-16, as CodeMirror counts
    expect(astral.text.slice(astral.hole.from, astral.hole.to)).toBe('$title == "𝒜"');
  });
  it("frameFor, empty + editing: the where line with an empty hole after `where `, for the caret", () => {
    const f = frameFor("", { editing: true });
    expect(f.text).toBe("select $path, $title, $updated_at from docs\nwhere \norder by $updated_at desc limit 25");
    expect(f.where).toBe(true);
    expect(f.hole).toEqual({ from: FRAME_BEFORE.length, to: FRAME_BEFORE.length });
    expect(f.text.split("\n")[1]).toBe("where ");
  });
  it("frameFor, empty + idle: two lines, no where at all, a closed zero-width hole; the same tokens as recentQuery('')", () => {
    const f = frameFor("");
    expect(f.text).toBe("select $path, $title, $updated_at from docs\norder by $updated_at desc limit 25");
    expect(f.where).toBe(false);
    expect(f.text.split("\n")).toHaveLength(2);
    expect(f.text.replace(/\n/g, " ")).toBe(recentQuery(""));
    expect(f.hole).toEqual({ from: "select $path, $title, $updated_at from docs".length, to: "select $path, $title, $updated_at from docs".length });
    expect(frameFor("", { editing: false })).toEqual(f);
  });
  it("matchQuery: ONE query per poll projecting $path and $title, the filter (when any) and-ed with the paths or-ed together, rooted, deduped, JSON-quoted; null without paths", () => {
    expect(matchQuery('status == "active"', ["/notes/alpha.md", "notes/beta.md", "/notes/alpha.md"]))
      .toBe('select $path, $title from docs where (status == "active") and ($path == "/notes/alpha.md" or $path == "/notes/beta.md")');
    expect(matchQuery("", ["/notes/alpha.md", "/notes/beta.md"])).toBe('select $path, $title from docs where ($path == "/notes/alpha.md" or $path == "/notes/beta.md")');
    expect(matchQuery("  ", ["/a.md"])).toBe('select $path, $title from docs where ($path == "/a.md")');
    expect(matchQuery("x", ['/odd "quoted" name.md'])).toBe('select $path, $title from docs where (x) and ($path == "/odd \\"quoted\\" name.md")');
    expect(matchQuery('status == "active"', [])).toBeNull();
    expect(matchQuery("", [])).toBeNull();
  });
  it("titlesByPath: rooted path → $title under both envelopes; a blank title is null, a hit without a path is skipped", () => {
    const titles = titlesByPath([
      { $id: "d_a", $path: "/notes/alpha.md", $title: "Alpha" },
      { id: "d_b", path: "notes/beta.md", $title: "  " },
      { id: "d_c", path: "/notes/gamma.md" },
      { $id: "d_x", $title: "no path" },
    ]);
    expect([...titles]).toEqual([["/notes/alpha.md", "Alpha"], ["/notes/beta.md", null], ["/notes/gamma.md", null]]);
    expect(titlesByPath([])).toEqual(new Map());
  });
  it("digestPaths: every revision's path, rooted and deduped, in order", () => {
    const page = [
      digest(1, "c_1", [{ doc: "d_a", path: "notes/alpha.md", contentHash: "a1" }]),
      digest(2, "c_2", [{ doc: "d_b", path: "/notes/beta.md", contentHash: "b1" }, { doc: "d_a", path: "/notes/alpha.md", contentHash: "a2" }]),
      digest(3, "c_3", []),
    ];
    expect(digestPaths(page)).toEqual(["/notes/alpha.md", "/notes/beta.md"]);
  });
  it("partitionByFilter: keeps matching revisions, drops the rest, hides and counts a digest left empty (deletions and moves included)", () => {
    const page = [
      digest(1, "c_1", [{ doc: "d_a", path: "notes/alpha.md", contentHash: "a1" }]),
      digest(2, "c_2", [{ doc: "d_b", path: "/notes/beta.md", contentHash: "b1" }, { doc: "d_a", path: "/notes/alpha.md", contentHash: "a2" }]),
      digest(3, "c_3", [{ doc: "d_g", path: "/notes/gamma.md", contentHash: "g1" }]),
      { ...digest(4, "c_4", []), summary: "delete /notes/alpha.md" },
    ];
    const { kept, hidden } = partitionByFilter(page, new Set(["/notes/alpha.md"]));
    expect(kept.map((d) => d.commit)).toEqual(["c_1", "c_2"]);
    expect(kept[1]!.revisions).toEqual([{ doc: "d_a", path: "/notes/alpha.md", contentHash: "a2" }]);
    expect(hidden).toBe(2);
    expect(partitionByFilter(page, new Set())).toEqual({ kept: [], hidden: 4 });
    expect(partitionByFilter([], new Set(["/x.md"]))).toEqual({ kept: [], hidden: 0 });
  });
  it("filterStateAfter: off for an empty filter, on when the server took it, invalid with the message when it refused it, on when something else failed", () => {
    expect(filterStateAfter("", null)).toEqual({ kind: "off" });
    expect(filterStateAfter("  ", { code: "filter_invalid", message: "x" })).toEqual({ kind: "off" });
    expect(filterStateAfter(' status == "active" ', null)).toEqual({ kind: "on", filter: 'status == "active"' });
    expect(filterStateAfter("status ==", { code: "filter_invalid", message: "unexpected ')' — expected a value (at offset 39)" }))
      .toEqual({ kind: "invalid", filter: "status ==", message: "unexpected ')' — expected a value (at offset 39)" });
    expect(filterStateAfter("status == 1", { message: "fetch failed" })).toEqual({ kind: "on", filter: "status == 1" });
    expect(filterStateAfter("status == 1", { code: "repo_not_found", message: "no such repo" })).toEqual({ kind: "on", filter: "status == 1" });
  });
  it("hiddenLine: a muted count, singular and plural, nothing for zero", () => {
    expect(hiddenLine(0)).toBeNull();
    expect(hiddenLine(1)).toBe("1 change hidden by the filter");
    expect(hiddenLine(3)).toBe("3 changes hidden by the filter");
  });
});

describe("rendering helpers", () => {
  it("createdDiff: a created document is one pure-addition hunk — lines that start with -, ---, + or a space are all additions, +N −0", () => {
    const content = "---\ntitle: New\ntags:\n- a\n---\n# New\n\n- bullet\n+ plus bullet\n  indented\n";
    const diff = createdDiff(content);
    const lines = diff.split("\n");
    expect(lines[0]).toBe("@@ -0,0 +1,10 @@");
    expect(lines.slice(1)).toEqual(["+---", "+title: New", "+tags:", "+- a", "+---", "+# New", "+", "+- bullet", "++ plus bullet", "+  indented"]);
    expect(lines.slice(1).map(diffLineKind).every((k) => k === "add")).toBe(true);
    expect(diffStats(diff)).toEqual({ added: 10, removed: 0 });
    expect(createdDiff("a\n\n")).toBe("@@ -0,0 +1,2 @@\n+a\n+"); // one trailing newline is the file's; the empty last line stays
    expect(createdDiff("a")).toBe("@@ -0,0 +1,1 @@\n+a");
    expect(createdDiff("\n")).toBe("@@ -0,0 +1,1 @@\n+");
    expect(createdDiff("")).toBe("");
  });
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
