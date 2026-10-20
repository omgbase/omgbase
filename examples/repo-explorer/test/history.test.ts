import { describe, expect, it } from "vitest";
import { byline, deletedRevisionsQuery, fetchAllRevisions, fetchDeleted, fetchRevisions, groupDeleted, previousOf, revisionsByPathQuery, revisionsOf, revisionsQuery } from "../src/lib/history.ts";
import { ScriptedCaller, page } from "./scripted.ts";

// A revisions row as the 5.0 server spells it: every attribute engine-provided, so `_`-prefixed (a revision carries no authored data).
const ROWS = [
  { _id: "r_nde4q7a", _path: "/texts/mutus-liber.md", _rev: "r_nde4q7a", _seq: 2, _ts: "2026-10-14T05:57:35.884Z", _origin: "api", _actor: "agent:mcp", _reason: "probe edit", _hash: "0490e9", _is_current: true, _doc_id: "d_ab22ane" },
  { _id: "r_dx8ttgq", _path: "/texts/mutus-liber.md", _rev: "r_dx8ttgq", _seq: 1, _ts: "2026-10-14T05:54:04.040Z", _origin: "observed", _actor: null, _reason: null, _hash: "ccd682", _is_current: false, _doc_id: "d_ab22ane" },
];

describe("the revisions queries", () => {
  it("a document's chronology by _doc_id (a move re-paths only the current revision), newest first", () => {
    expect(revisionsQuery("d_7")).toBe('select _rev, _seq, _ts, _origin, _actor, _reason, _hash, _is_current, _doc_id from revisions where _doc_id == "d_7" order by _seq desc');
    expect(revisionsByPathQuery("processes/calcination.md")).toBe('select _rev, _seq, _ts, _origin, _actor, _reason, _hash, _is_current, _doc_id from revisions where _doc._path == "/processes/calcination.md" order by _seq desc');
    expect(deletedRevisionsQuery()).toBe("select _rev, _seq, _ts, _origin, _actor, _reason, _hash, _is_current, _doc_id from revisions where _doc == null order by _ts desc, _seq desc");
  });
  it("reads rows as the server spells them (5.0: _rev, _seq, … off the hit)", () => {
    const rows = revisionsOf(ROWS);
    expect(rows[0]).toEqual({ rev: "r_nde4q7a", path: "/texts/mutus-liber.md", seq: 2, ts: "2026-10-14T05:57:35.884Z", origin: "api", actor: "agent:mcp", reason: "probe edit", hash: "0490e9", isCurrent: true, docId: "d_ab22ane" });
    expect(rows[1]!.actor).toBeNull();
    expect(revisionsOf([{ _seq: 1 }])).toEqual([]);
    // A 4.x row (bare names) is not an envelope any more: no `_id`/`_path`, no row.
    expect(revisionsOf([{ id: "r_1", path: "/a.md", rev: "r_1", seq: 1 }])).toEqual([]);
    expect(previousOf(rows, "r_nde4q7a")?.rev).toBe("r_dx8ttgq");
    expect(previousOf(rows, "r_dx8ttgq")).toBeNull();
    expect(previousOf(rows, "r_nope")).toBeNull();
    expect(byline(rows[0]!)).toBe("api · agent:mcp");
    expect(byline(rows[1]!)).toBe("observed");
    expect(byline({ origin: "api", actor: "api:cli" })).toBe("api:cli");
  });
  it("groups deleted documents' revisions by document, the latest path as the document's", () => {
    const groups = groupDeleted(revisionsOf([...ROWS, { _id: "r_9", _path: "/old/x.md", _rev: "r_9", _seq: 1, _ts: "2026-10-01T00:00:00Z", _origin: "observed", _actor: null, _reason: null, _hash: "h", _is_current: true, _doc_id: "d_x" }]));
    expect(groups.map((g) => [g.docId, g.path, g.revisions.length])).toEqual([["d_ab22ane", "/texts/mutus-liber.md", 2], ["d_x", "/old/x.md", 1]]);
  });
});

describe("history over a scripted minimal server", () => {
  it("fetchRevisions runs the chronology through `query` with a page limit (a custom order has no cursor)", async () => {
    const s = new ScriptedCaller({ query: () => page(ROWS) });
    const rows = await fetchRevisions(s, "d_ab22ane", "alchemy");
    expect(rows.map((r) => r.seq)).toEqual([2, 1]);
    expect(s.calls).toEqual([{ name: "query", args: { query: revisionsQuery("d_ab22ane"), limit: 200, repo: "alchemy" } }]);
  });
  it("fetchAllRevisions pages the default order and sorts by seq itself", async () => {
    const s = new ScriptedCaller({ query: (_a, n) => (n === 0 ? page([ROWS[1]!], { truncated: true, cursor: "c" }) : page([ROWS[0]!])) });
    const rows = await fetchAllRevisions(s, "d_ab22ane", null);
    expect(rows.map((r) => r.seq)).toEqual([2, 1]);
    expect(s.names()).toEqual(["query", "query"]);
    expect(String(s.argsOf("query", 0)!.query)).not.toContain("order by");
  });
  it("fetchDeleted lists the revisions of deleted documents (from revisions where _doc == null)", async () => {
    const s = new ScriptedCaller({ query: () => page(ROWS) });
    const groups = await fetchDeleted(s, null);
    expect(groups).toHaveLength(1);
    expect(s.argsOf("query")).toEqual({ query: deletedRevisionsQuery(), limit: 500 });
  });
});
