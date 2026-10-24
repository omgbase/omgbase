import { describe, expect, it } from "vitest";
import { DEFAULT_ROUTE, graphRoute, openDocRoute, parseRoute, routeHash } from "../src/lib/route.ts";

describe("the hash route", () => {
  it("parses and prints the open document, a revision, the tab, a block, the deleted list", () => {
    expect(parseRoute("")).toEqual(DEFAULT_ROUTE);
    expect(parseRoute("#doc=/processes/calcination.md")).toEqual({ ...DEFAULT_ROUTE, doc: "/processes/calcination.md" });
    expect(parseRoute("#doc=processes/calcination.md&rev=r_7&tab=history&block=b_1")).toEqual({ doc: "/processes/calcination.md", rev: "r_7", tab: "history", deleted: false, block: "b_1", graphQuery: null });
    expect(parseRoute("#deleted")).toEqual({ ...DEFAULT_ROUTE, deleted: true });
    expect(parseRoute("#doc=/a.md&tab=bogus").tab).toBe("document");
    expect(parseRoute("#doc=/a.md&tab=graph").tab).toBe("graph");
    expect(routeHash({ doc: "/processes/calcination.md" })).toBe("#doc=/processes/calcination.md");
    expect(routeHash({ doc: "/a b.md", rev: "r_7", tab: "history" })).toBe("#doc=/a+b.md&rev=r_7&tab=history");
    expect(routeHash({ deleted: true })).toBe("#deleted");
    expect(routeHash({})).toBe("");
    const r = { doc: "/x.md", rev: "r_1", tab: "links" as const, deleted: false, block: null, graphQuery: null };
    expect(parseRoute(routeHash(r))).toEqual(r);
  });
  it("#graph=<query>: a query's rows as a graph — round-trips spaces, quotes, braces, `==`, `/` and `+`; blank is none; graphRoute opens no document", () => {
    const q = 'docs { select _path, _title, card: status + " · " + owner where layer == "canon" and _path ~* "/processes/" }';
    const hash = routeHash({ graphQuery: q });
    expect(hash.startsWith("#graph=docs+%7B+select+_path")).toBe(true);
    expect(hash).not.toContain(" ");
    expect(parseRoute(hash)).toEqual({ ...DEFAULT_ROUTE, graphQuery: q });
    expect(parseRoute("#graph=docs+%7B+%7D")).toEqual({ ...DEFAULT_ROUTE, graphQuery: "docs { }" });
    expect(parseRoute("#graph=")).toEqual(DEFAULT_ROUTE);
    expect(parseRoute("#graph=+++")).toEqual(DEFAULT_ROUTE);
    expect(routeHash({ graphQuery: null })).toBe("");
    expect(graphRoute("  docs { }  ")).toEqual({ ...DEFAULT_ROUTE, graphQuery: "docs { }" });
    expect(graphRoute("   ")).toEqual(DEFAULT_ROUTE);
    // A graph route and a document route are distinct: opening a document drops the query.
    expect(openDocRoute(graphRoute("docs { }"), "/a.md").graphQuery).toBeNull();
    expect(parseRoute(routeHash({ ...DEFAULT_ROUTE, doc: "/a.md", graphQuery: "docs { }" }))).toEqual({ ...DEFAULT_ROUTE, doc: "/a.md", graphQuery: "docs { }" });
  });
  it("openDocRoute: a new document opens on the document tab; the same document keeps its tab", () => {
    const current = { doc: "/a.md", rev: "r_1", tab: "history" as const, deleted: false, block: null, graphQuery: null };
    expect(openDocRoute(current, "/b.md")).toEqual({ doc: "/b.md", rev: null, tab: "document", deleted: false, block: null, graphQuery: null });
    expect(openDocRoute(current, "/a.md")).toEqual({ doc: "/a.md", rev: null, tab: "history", deleted: false, block: null, graphQuery: null });
    expect(openDocRoute(current, "/a.md", { keepTab: false, block: "b_2" })).toEqual({ doc: "/a.md", rev: null, tab: "document", deleted: false, block: "b_2", graphQuery: null });
  });
});
