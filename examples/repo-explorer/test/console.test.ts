import { describe, expect, it } from "vitest";
import { DEFAULT_LIMIT, cellOf, columnsOf, describeToolError, fetchSyntax, footerText, isRunShortcut, locatorQuery, nextPage, runConsole, scalarLine } from "../src/lib/console.ts";
import { OmgError } from "../src/lib/mcp-client.ts";
import { queryResultOf } from "../src/lib/query.ts";
import { ScriptedCaller, page } from "./scripted.ts";

describe("the result table", () => {
  it("columnsOf: _id and _path first (the 5.0 envelope), then every other key in first-seen order; a bare `id`/`path` is an ordinary (authored) column", () => {
    expect(columnsOf([{ _id: "d_1", _path: "/a.md", _title: "A" }, { _id: "d_2", _path: "/b.md", layer: "canon", _title: null }])).toEqual(["_id", "_path", "_title", "layer"]);
    expect(columnsOf([{ _title: "A" }])).toEqual(["_title"]);
    expect(columnsOf([{ _path: "/a.md", _id: "d_1", path: "authored", id: 7 }])).toEqual(["_id", "_path", "path", "id"]);
    expect(columnsOf([])).toEqual([]);
  });
  it("cellOf: a rooted path and an omgbase id are links; a row-as-value { _id, _path } is its path; objects are JSON", () => {
    expect(cellOf("/substances/salt.md")).toEqual({ text: "/substances/salt.md", link: { kind: "doc", path: "/substances/salt.md" } });
    expect(cellOf("d_zbz0k2v")).toEqual({ text: "d_zbz0k2v", link: { kind: "id", id: "d_zbz0k2v", of: "doc" } });
    expect(cellOf("b_153")).toEqual({ text: "b_153", link: { kind: "id", id: "b_153", of: "block" } });
    expect(cellOf("r_7")).toEqual({ text: "r_7", link: { kind: "id", id: "r_7", of: "revision" } });
    expect(cellOf({ _id: "d_1", _path: "/x.md" })).toEqual({ text: "/x.md", link: { kind: "doc", path: "/x.md" } });
    expect(cellOf({ _id: "d_1", _path: "/x.md", t: 1 })).toEqual({ text: '{"_id":"d_1","_path":"/x.md","t":1}', link: null });
    // The 4.x bare pair is just an object in 5.0 (`id`/`path` are authored keys).
    expect(cellOf({ id: "d_1", path: "/x.md" })).toEqual({ text: '{"id":"d_1","path":"/x.md"}', link: null });
    expect(cellOf(["a", "b"])).toEqual({ text: '["a","b"]', link: null });
    expect(cellOf(null)).toEqual({ text: "null", link: null });
    expect(cellOf(undefined)).toEqual({ text: "", link: null });
    expect(cellOf(true)).toEqual({ text: "true", link: null });
    expect(cellOf("canon")).toEqual({ text: "canon", link: null });
    expect(cellOf("/not a path")).toEqual({ text: "/not a path", link: null });
  });
  it("scalarLine for the scalar consumers and values; null for hits", () => {
    expect(scalarLine(queryResultOf({ hits: [], consumer: "count", count: 19 }))).toBe("count: 19");
    expect(scalarLine(queryResultOf({ hits: [], consumer: "exists", exists: false }))).toBe("exists: false");
    expect(scalarLine(queryResultOf({ hits: [], consumer: "none", none: true }))).toBe("none: true");
    expect(scalarLine(queryResultOf({ hits: [], consumer: "collect", values: ["/a.md", "/b.md"] }))).toBe("2 values");
    expect(scalarLine(queryResultOf({ hits: [{ _id: "d_1", _path: "/a.md" }], consumer: "collect" }))).toBeNull();
  });
  it("footerText and nextPage: a keyset cursor pages; a custom order by truncates without one", () => {
    const paged = queryResultOf({ hits: [{}], truncated: true, cursor: "WyIvYS5tZCIsImRfMSJd", consumer: "collect" });
    expect(footerText(paged, 50)).toBe("50 rows · more");
    expect(nextPage(paged, { limit: 50 })).toEqual({ limit: 50, cursor: "WyIvYS5tZCIsImRfMSJd" });
    const ordered = queryResultOf({ hits: [{}], truncated: true, cursor: null, consumer: "collect" });
    expect(footerText(ordered, 5)).toBe("5 rows · truncated (a custom order by disables the cursor — page with limit/offset in the query)");
    expect(nextPage(ordered, {})).toBeNull();
    expect(footerText(queryResultOf({ hits: [{}], truncated: false, cursor: null }), 1)).toBe("1 row");
  });
  it("keeps the hints as the server sent them (the §1.5 unknown-name advice), absent when none", () => {
    const r = queryResultOf({ hits: [{ _id: "d_0", _path: "/index.md" }], truncated: false, cursor: null, consumer: "collect", hints: ["no document in this repository carries a property `titel`; did you mean `_title`?"] });
    expect(r.hints).toHaveLength(1);
    expect(queryResultOf({ hits: [] }).hints).toBeUndefined();
  });
});

describe("errors", () => {
  it("describeToolError: the engine's code, message, data.hint and data.fix", () => {
    const e = new OmgError("plan_mismatch", "the effects or the documents they target changed since the plan was made; re-plan", { expected: "x", actual: "y", fix: '{"effects":[{"op":"set"}]}' });
    expect(describeToolError(e)).toEqual({ code: "plan_mismatch", message: e.message, fix: '{"effects":[{"op":"set"}]}', hint: null, retriable: false });
    const q = new OmgError("filter_invalid", "unexpected end of query — expected a value (at offset 15)", { reason: "…", hint: "OQX" });
    expect(describeToolError(q)).toMatchObject({ code: "filter_invalid", hint: "OQX", fix: null });
    expect(describeToolError(new Error("network down"))).toEqual({ code: "error", message: "network down", fix: null, hint: null, retriable: false });
  });
  it("isRunShortcut: Cmd/Ctrl + Enter", () => {
    expect(isRunShortcut({ key: "Enter", metaKey: true, ctrlKey: false })).toBe(true);
    expect(isRunShortcut({ key: "Enter", metaKey: false, ctrlKey: true })).toBe(true);
    expect(isRunShortcut({ key: "Enter", metaKey: false, ctrlKey: false })).toBe(false);
    expect(isRunShortcut({ key: "a", metaKey: true, ctrlKey: false })).toBe(false);
  });
  it("locatorQuery: how a clicked id finds its document (5.0 names)", () => {
    expect(locatorQuery("b_153")).toBe('select _path from blocks where _id == "b_153"');
    expect(locatorQuery("n_1")).toBe('select _path from nodes where _id == "n_1"');
    expect(locatorQuery("e_1")).toBe('select _path from links where _id == "e_1"');
    expect(locatorQuery("r_7")).toBe('select _path, _doc_id from revisions where _rev == "r_7"');
    expect(locatorQuery("d_1")).toBeNull();
    expect(locatorQuery("c_1")).toBeNull();
  });
});

describe("the console over a scripted minimal server", () => {
  it("runs `query` with the console's limit, pages with the cursor, fetches query_syntax once", async () => {
    const s = new ScriptedCaller({
      query: (a, n) => (n === 0 ? page([{ _id: "d_1", _path: "/a.md" }], { truncated: true, cursor: "c1" }) : page([{ _id: "d_2", _path: "/b.md" }])),
      query_syntax: () => ({ syntax: "# query — OQX syntax reference" }),
    });
    const first = await runConsole(s, "from docs", { repo: null });
    const next = nextPage(first, { repo: null })!;
    const second = await runConsole(s, "from docs", next);
    expect(second.hits).toEqual([{ _id: "d_2", _path: "/b.md" }]);
    expect(await fetchSyntax(s)).toBe("# query — OQX syntax reference");
    expect(s.calls).toEqual([
      { name: "query", args: { query: "from docs", limit: DEFAULT_LIMIT } },
      { name: "query", args: { query: "from docs", limit: DEFAULT_LIMIT, cursor: "c1" } },
      { name: "query_syntax", args: {} },
    ]);
  });
  it("surfaces the engine's error envelope", async () => {
    const s = new ScriptedCaller({ query: () => new OmgError("filter_invalid", "`target` is not a field of links (fields: _id, _path, …)", { hint: "OQX" }) });
    await expect(runConsole(s, "select target from links")).rejects.toMatchObject({ code: "filter_invalid" });
  });
});
