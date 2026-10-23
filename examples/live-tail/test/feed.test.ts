import { describe, expect, it } from "vitest";
import {
  DIFF_VIEW_KEY, FRAME_AFTER, FRAME_BEFORE, advanceCursor, byline, cardFields, createdDiff, diffLineKind, diffStats, diffViewOf, digestPaths, entryCard, entryFromDigest, filterStateAfter, formatStats, formatTime, frameFor, hiddenLine, latestChange, latestPair, loadDiffView, matchQuery, pairForCommit, partitionByFilter, pollMs, prependDigests, recentCard, recentFromHits, recentQuery, saveDiffView, startCursor, sumStats, titlesByPath,
  type Digest, type DocVersion, type FeedEntry, type RecentDoc,
} from "../src/lib/feed.ts";
import { NAMES_4 } from "../src/lib/paths.ts";

const digest = (seq: number, commit = `c_${seq}`, revisions: Digest["revisions"] = [{ id: "d_a", path: "/notes/alpha.md", hash: "aa" }]): Digest => ({
  commit, seq, ts: `2026-10-10T12:00:0${seq % 10}Z`, origin: "api", actor: "agent:mcp", summary: `docs_set_meta ${revisions.map((r) => r.path).join(", ")}`, revisions,
});
const version = (i: number, commit: string): DocVersion => ({ rev: `r_${i}`, seq: i, commit, updated_at: "2026-10-10T12:00:00Z", origin: "observed", actor: null, hash: `h${i}`, isCurrent: false });

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
    const e = entryFromDigest(digest(7, "c_7", [{ id: "d_a", path: "notes/alpha.md", hash: "aa" }, { id: "d_b", path: "/notes/beta.md", hash: "bb" }]));
    expect(e).toEqual({
      key: "c_7", seq: 7, ts: "2026-10-10T12:00:07Z", origin: "api", actor: "agent:mcp", summary: "docs_set_meta notes/alpha.md, /notes/beta.md",
      changes: [{ id: "d_a", path: "/notes/alpha.md", title: null, hash: "aa" }, { id: "d_b", path: "/notes/beta.md", title: null, hash: "bb" }],
    });
    expect(byline(e)).toBe("api · agent:mcp");
    expect(byline({ origin: "observed", actor: null })).toBe("observed");
    expect(byline({ origin: "api", actor: "api:cli" })).toBe("api:cli"); // the actor already carries the origin
    expect(byline({ origin: "api", actor: "api" })).toBe("api");
  });
  it("gives each change its title from the poll's lookup, by rooted path; a document the lookup lacks (deleted, moved away) keeps the path alone", () => {
    const titles = new Map([["/notes/alpha.md", "Alpha"], ["/notes/beta.md", null]]);
    const e = entryFromDigest(digest(7, "c_7", [
      { id: "d_a", path: "notes/alpha.md", hash: "aa" }, { id: "d_b", path: "/notes/beta.md", hash: "bb" }, { id: "d_g", path: "/notes/gone.md", hash: "gg" },
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
  it("asks for the most recently updated documents — the 5.0 engine names by default, the bare 4.x ones on request", () => {
    expect(recentQuery()).toBe("docs { select _path, _title, _updated_at order by _updated_at desc limit 25 }");
    expect(recentQuery("")).toBe(recentQuery());
    expect(recentQuery("", NAMES_4)).toBe("docs { select path, title, updated_at order by updated_at desc limit 25 }");
  });
  it("reads hits: the envelope's _id/_path with the projected _title/_updated_at", () => {
    const hit = { _id: "d_a", _path: "/notes/alpha.md", _title: "Alpha", _updated_at: "2026-10-10T12:00:00Z" };
    expect(recentFromHits([hit])).toEqual([{ id: "d_a", path: "/notes/alpha.md", title: "Alpha", updatedAt: "2026-10-10T12:00:00Z", latest: null }]);
    // A 4.x server's hit, bare.
    const old = { id: "d_a", path: "/notes/alpha.md", title: "Alpha", updated_at: "2026-10-10T12:00:00Z" };
    expect(recentFromHits([old])).toEqual(recentFromHits([hit]));
  });
  it("roots a bare path, drops an empty title, skips a hit without a path", () => {
    expect(recentFromHits([{ _id: "d_b", _path: "notes/beta.md", _title: "  ", _updated_at: null }, { _id: "d_x" }]))
      .toEqual([{ id: "d_b", path: "/notes/beta.md", title: null, updatedAt: null, latest: null }]);
  });
  it("latestChange: the last version's seq/commit/origin/actor for the card header; null without versions", () => {
    expect(latestChange([version(1, "c_1"), { ...version(2, "c_2"), origin: "api", actor: "agent:mcp" }])).toEqual({ seq: 2, commit: "c_2", origin: "api", actor: "agent:mcp" });
    expect(latestChange([])).toBeNull();
  });
});

describe("the card", () => {
  const now = new Date(2026, 9, 10, 15, 0, 0);
  const today = new Date(2026, 9, 10, 9, 5, 7).toISOString();
  const values = (fields: { value: string }[]) => fields.map((f) => f.value);
  const noDuplicates = (fields: { label: string; value: string }[]) => {
    const seen = new Map<string, string>();
    for (const f of fields) {
      expect(seen.has(f.value), `"${f.value}" is shown twice (${seen.get(f.value)} and ${f.label})`).toBe(false);
      seen.set(f.value, f.label);
    }
  };

  it("a recent card: time, title, path, seq · commit, by, stats — each once; before the history is in, the document alone", () => {
    const doc: RecentDoc = { id: "d_a", path: "/notes/alpha.md", title: "Alpha", updatedAt: today, latest: { seq: 6, commit: "c_761p702", origin: "api", actor: null } };
    const fields = cardFields(recentCard(doc, { added: 1, removed: 0 }), now);
    expect(fields).toEqual([
      { label: "time", value: "09:05:07" }, { label: "title", value: "Alpha" }, { label: "path", value: "/notes/alpha.md" },
      { label: "seq", value: "seq 6" }, { label: "commit", value: "c_761p702" }, { label: "by", value: "api" }, { label: "stats", value: "+1 −0" },
    ]);
    noDuplicates(fields);
    expect(values(cardFields(recentCard({ ...doc, latest: null }, null), now))).toEqual(["09:05:07", "Alpha", "/notes/alpha.md"]);
  });
  it("the title is shown only when it adds to the path: a null title or one equal to the path leaves the path once", () => {
    const base: RecentDoc = { id: "d_r", path: "/README.md", title: null, updatedAt: null, latest: null };
    expect(values(cardFields(recentCard(base, null), now))).toEqual(["/README.md"]);
    expect(values(cardFields(recentCard({ ...base, title: "/README.md" }, null), now))).toEqual(["/README.md"]);
  });
  it("a single-document feed entry: the digest's time/seq/commit/by with that document's title/path and stats; the summary is NOT shown", () => {
    const e = entryFromDigest({ ...digest(6, "c_761p702"), ts: today, actor: null, summary: "api(?): /notes/alpha.md — 1 inserted" }, new Map([["/notes/alpha.md", "Alpha"]]));
    const card = entryCard(e, new Map([["d_a", { added: 1, removed: 0 }]]));
    expect(card.rows).toEqual([]);
    expect(card.note).toBeNull();
    const fields = cardFields(card, now);
    expect(values(fields)).toEqual(["09:05:07", "Alpha", "/notes/alpha.md", "seq 6", "c_761p702", "api", "+1 −0"]);
    expect(fields.map((f) => f.value).join(" ")).not.toContain("inserted");
    noDuplicates(fields);
    expect(entryCard(e, new Map()).stats).toBeNull(); // the diff is not in yet
  });
  it("a multi-document digest: the header carries the digest's values and the TOTAL stats; each document gets a row with its title/path and its own stats, nothing repeated", () => {
    const e = entryFromDigest({ ...digest(9, "c_9", [{ id: "d_a", path: "/notes/alpha.md", hash: "a" }, { id: "d_b", path: "/notes/beta.md", hash: "b" }]), ts: today }, new Map([["/notes/alpha.md", "Alpha"]]));
    const card = entryCard(e, new Map([["d_a", { added: 2, removed: 1 }], ["d_b", { added: 1, removed: 0 }]]));
    expect(card.title).toBeNull();
    expect(card.path).toBeNull();
    expect(card.stats).toEqual({ added: 3, removed: 1 });
    expect(card.rows).toEqual([{ title: "Alpha", path: "/notes/alpha.md", stats: { added: 2, removed: 1 } }, { title: null, path: "/notes/beta.md", stats: { added: 1, removed: 0 } }]);
    const fields = cardFields(card, now);
    expect(values(fields)).toEqual(["09:05:07", "seq 9", "c_9", "api · agent:mcp", "+3 −1", "Alpha", "/notes/alpha.md", "+2 −1", "/notes/beta.md", "+1 −0"]);
    noDuplicates(fields);
    expect(entryCard(e, new Map([["d_a", { added: 2, removed: 1 }]])).stats).toEqual({ added: 2, removed: 1 }); // the total over what is known so far
  });
  it("a digest without revisions (a deletion, a move) keeps the server's summary as the card's note — the only statement of what happened", () => {
    const e = entryFromDigest({ ...digest(4, "c_4", []), ts: today, actor: null, summary: "api(?): deleted /notes/old.md" });
    const card = entryCard(e, new Map());
    expect(card.note).toBe("api(?): deleted /notes/old.md");
    const fields = cardFields(card, now);
    expect(values(fields)).toEqual(["09:05:07", "seq 4", "c_4", "api", "api(?): deleted /notes/old.md"]);
    noDuplicates(fields);
  });
  it("sumStats and formatStats", () => {
    expect(sumStats([])).toBeNull();
    expect(sumStats([null, null])).toBeNull();
    expect(sumStats([{ added: 1, removed: 2 }, null, { added: 3, removed: 0 }])).toEqual({ added: 4, removed: 2 });
    expect(formatStats({ added: 10, removed: 0 })).toBe("+10 −0");
  });
});

describe("the filter", () => {
  it("recentQuery: the filter becomes the where clause; none or blank leaves the plain query (no empty where)", () => {
    expect(recentQuery('status == "active"')).toBe('docs { select _path, _title, _updated_at where status == "active" order by _updated_at desc limit 25 }');
    expect(recentQuery("  a == 1 or b == 2  ")).toBe("docs { select _path, _title, _updated_at where a == 1 or b == 2 order by _updated_at desc limit 25 }");
    expect(recentQuery("")).toBe("docs { select _path, _title, _updated_at order by _updated_at desc limit 25 }");
    expect(recentQuery("   ")).toBe(recentQuery(""));
    expect(recentQuery('status == "active"', NAMES_4)).toBe('docs { select path, title, updated_at where status == "active" order by updated_at desc limit 25 }');
  });
  it("frameFor, filled (idle or editing): five lines, the filter in the hole on the where line; the same tokens as recentQuery", () => {
    for (const editing of [false, true]) {
      const f = frameFor('status == "active"', { editing });
      expect(f.text).toBe('docs {\n  select _path, _title, _updated_at\n  where status == "active"\n  order by _updated_at desc limit 25\n}');
      expect(f.where).toBe(true);
      expect(f.text.split("\n")).toHaveLength(5);
      expect(f.text.replace(/\s+/g, " ")).toBe(recentQuery('status == "active"'));
      expect(f.text.slice(f.hole.from, f.hole.to)).toBe('status == "active"');
      expect(f.text.slice(0, f.hole.from)).toBe(FRAME_BEFORE);
      expect(f.text.slice(f.hole.to)).toBe(FRAME_AFTER);
      expect(f.text.split("\n")[2]).toBe('  where status == "active"'); // the hole lives on the third line alone
    }
    const astral = frameFor('title == "𝒜"'); // offsets are UTF-16, as CodeMirror counts
    expect(astral.text.slice(astral.hole.from, astral.hole.to)).toBe('title == "𝒜"');
    // The 4.x names spell the frame bare; the hole is the same text.
    const old = frameFor('status == "active"', { names: NAMES_4 });
    expect(old.text).toBe('docs {\n  select path, title, updated_at\n  where status == "active"\n  order by updated_at desc limit 25\n}');
    expect(old.text.slice(old.hole.from, old.hole.to)).toBe('status == "active"');
    expect(old.text.replace(/\s+/g, " ")).toBe(recentQuery('status == "active"', NAMES_4));
  });
  it("frameFor, empty + editing: the where line with an empty hole after `where `, for the caret", () => {
    const f = frameFor("", { editing: true });
    expect(f.text).toBe("docs {\n  select _path, _title, _updated_at\n  where \n  order by _updated_at desc limit 25\n}");
    expect(f.where).toBe(true);
    expect(f.hole).toEqual({ from: FRAME_BEFORE.length, to: FRAME_BEFORE.length });
    expect(f.text.split("\n")[2]).toBe("  where ");
  });
  it("frameFor, empty + idle: four lines, no where at all, a closed zero-width hole at the end of the select line; the same tokens as recentQuery('')", () => {
    const f = frameFor("");
    expect(f.text).toBe("docs {\n  select _path, _title, _updated_at\n  order by _updated_at desc limit 25\n}");
    expect(f.where).toBe(false);
    expect(f.text.split("\n")).toHaveLength(4);
    expect(f.text.replace(/\s+/g, " ")).toBe(recentQuery(""));
    expect(f.hole).toEqual({ from: "docs {\n  select _path, _title, _updated_at".length, to: "docs {\n  select _path, _title, _updated_at".length });
    expect(frameFor("", { editing: false })).toEqual(f);
  });
  it("matchQuery: ONE query per poll projecting _path and _title, the filter (when any) and-ed with the paths or-ed together, rooted, deduped, JSON-quoted; null without paths", () => {
    expect(matchQuery('status == "active"', ["/notes/alpha.md", "notes/beta.md", "/notes/alpha.md"]))
      .toBe('docs { select _path, _title where (status == "active") and (_path == "/notes/alpha.md" or _path == "/notes/beta.md") }');
    expect(matchQuery("", ["/notes/alpha.md", "/notes/beta.md"])).toBe('docs { select _path, _title where (_path == "/notes/alpha.md" or _path == "/notes/beta.md") }');
    expect(matchQuery("  ", ["/a.md"])).toBe('docs { select _path, _title where (_path == "/a.md") }');
    expect(matchQuery("x", ['/odd "quoted" name.md'])).toBe('docs { select _path, _title where (x) and (_path == "/odd \\"quoted\\" name.md") }');
    expect(matchQuery('status == "active"', [])).toBeNull();
    expect(matchQuery("", [])).toBeNull();
    // The 4.x names, bare.
    expect(matchQuery('status == "active"', ["/notes/alpha.md"], NAMES_4)).toBe('docs { select path, title where (status == "active") and (path == "/notes/alpha.md") }');
  });
  it("titlesByPath: rooted path → title; a blank title is null, a hit without a path is skipped; a 4.x hit reads the same", () => {
    const titles = titlesByPath([
      { _id: "d_a", _path: "/notes/alpha.md", _title: "Alpha" },
      { _id: "d_b", _path: "notes/beta.md", _title: "  " },
      { _id: "d_c", _path: "/notes/gamma.md" },
      { _id: "d_x", _title: "no path" },
    ]);
    expect([...titles]).toEqual([["/notes/alpha.md", "Alpha"], ["/notes/beta.md", null], ["/notes/gamma.md", null]]);
    expect([...titlesByPath([{ id: "d_a", path: "/notes/alpha.md", title: "Alpha" }])]).toEqual([["/notes/alpha.md", "Alpha"]]);
    expect(titlesByPath([])).toEqual(new Map());
  });
  it("digestPaths: every revision's path, rooted and deduped, in order", () => {
    const page = [
      digest(1, "c_1", [{ id: "d_a", path: "notes/alpha.md", hash: "a1" }]),
      digest(2, "c_2", [{ id: "d_b", path: "/notes/beta.md", hash: "b1" }, { id: "d_a", path: "/notes/alpha.md", hash: "a2" }]),
      digest(3, "c_3", []),
    ];
    expect(digestPaths(page)).toEqual(["/notes/alpha.md", "/notes/beta.md"]);
  });
  it("partitionByFilter: keeps matching revisions, drops the rest, hides and counts a digest left empty (deletions and moves included)", () => {
    const page = [
      digest(1, "c_1", [{ id: "d_a", path: "notes/alpha.md", hash: "a1" }]),
      digest(2, "c_2", [{ id: "d_b", path: "/notes/beta.md", hash: "b1" }, { id: "d_a", path: "/notes/alpha.md", hash: "a2" }]),
      digest(3, "c_3", [{ id: "d_g", path: "/notes/gamma.md", hash: "g1" }]),
      { ...digest(4, "c_4", []), summary: "delete /notes/alpha.md" },
    ];
    const { kept, hidden } = partitionByFilter(page, new Set(["/notes/alpha.md"]));
    expect(kept.map((d) => d.commit)).toEqual(["c_1", "c_2"]);
    expect(kept[1]!.revisions).toEqual([{ id: "d_a", path: "/notes/alpha.md", hash: "a2" }]);
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
    expect(diffLineKind("--- a line that starts with dashes")).toBe("del"); // no file headers exist in docs_diff_unified output
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
  it("the diff view toggle persists: text by default, markdown when stored, anything else back to text", () => {
    expect(diffViewOf(null)).toBe("text");
    expect(diffViewOf(undefined)).toBe("text");
    expect(diffViewOf("markdown")).toBe("markdown");
    expect(diffViewOf("text")).toBe("text");
    expect(diffViewOf("Markdown")).toBe("text");
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    expect(loadDiffView(storage)).toBe("text");
    saveDiffView(storage, "markdown");
    expect(store.get(DIFF_VIEW_KEY)).toBe("markdown");
    expect(loadDiffView(storage)).toBe("markdown");
    saveDiffView(storage, "text");
    expect(loadDiffView(storage)).toBe("text");
    expect(DIFF_VIEW_KEY).toBe("omgbase-live-tail.view");
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
