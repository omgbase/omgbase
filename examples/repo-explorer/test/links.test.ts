import { describe, expect, it } from "vitest";
import { byNameQuery, fetchLinks, inboundQuery, linkProvenance, linkRowsOf, linkTarget, outboundQuery, resolveWikilink, wikiStem, wikilinkQuery } from "../src/lib/links.ts";
import { ScriptedCaller, page } from "./scripted.ts";

const P = "/processes/calcination.md";

describe("the two link queries", () => {
  it("inbound: links whose _dst_path is the document; outbound: links whose _path (the source) is (5.0: every link attribute is engine-provided, so `_`-prefixed)", () => {
    expect(inboundQuery(P)).toBe('select _path, _block_id, _provenance, _field, _anchor from links where _dst_path == "/processes/calcination.md"');
    expect(outboundQuery("processes/calcination.md")).toBe('select _dst_path, _dst_id, _dst_kind, _uri, _provenance, _field, _anchor from links where _path == "/processes/calcination.md"');
  });
  it("by name: the unresolved [[wikilinks]] naming the document (_dst_id is phantom:<stem>)", () => {
    expect(wikiStem("/substances/salt.md")).toBe("salt");
    expect(wikiStem("/x/no-extension")).toBe("no-extension");
    expect(byNameQuery("/substances/salt.md")).toBe('select _path, _block_id, _provenance, _field, _anchor from links where _dst_id == "phantom:salt"');
  });
  it("reads link rows as the server spells them (a wikilink naming no document has _dst_path null)", () => {
    const rows = linkRowsOf([
      { _id: "e_1", _path: "/index.md", _block_id: "b_8", _dst_path: P, _provenance: "link", _field: null, _anchor: null, _uri: null, _dst_kind: "document" },
      { _id: "e_2", _path: P, _dst_path: null, _dst_id: "phantom:salt", _dst_kind: "document", _provenance: "link", _anchor: null, _uri: null, _field: null },
      { _id: "e_3", _path: P, _dst_path: null, _dst_id: "x_1", _dst_kind: "external", _provenance: "frontmatter", _field: "homepage", _uri: "https://example.com/" },
      { _id: "e_4", _dst_path: P },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ id: "e_1", path: "/index.md", blockId: "b_8", dstPath: P, provenance: "link" });
    expect(linkTarget(rows[0]!)).toEqual({ text: P, doc: P, href: null, dangling: false });
    expect(linkTarget(rows[1]!)).toEqual({ text: "salt (dangling)", doc: null, href: null, dangling: true });
    expect(linkTarget(rows[2]!)).toEqual({ text: "https://example.com/", doc: null, href: "https://example.com/", dangling: false });
    expect(linkTarget({ ...rows[1]!, dstId: null })).toEqual({ text: "(unresolved)", doc: null, href: null, dangling: true });
    expect(linkProvenance(rows[0]!)).toBe("link");
    expect(linkProvenance(rows[2]!)).toBe("frontmatter · homepage");
  });
});

describe("fetchLinks over a scripted minimal server", () => {
  it("runs the three queries through `query` (paged) and nothing else", async () => {
    const s = new ScriptedCaller({
      query: (a) => {
        const q = String(a.query);
        if (q.includes("_dst_path ==")) return page([{ _id: "e_1", _path: "/index.md", _block_id: "b_8", _provenance: "link" }]);
        if (q.includes("_dst_id ==")) return page([{ _id: "e_3", _path: "/substances/salt.md", _block_id: "b_9", _provenance: "link" }]);
        return page([{ _id: "e_2", _path: P, _dst_path: "/substances/salt.md", _dst_kind: "document", _provenance: "link" }]);
      },
    });
    const l = await fetchLinks(s, P, "alchemy");
    expect(l.inbound.map((r) => r.path)).toEqual(["/index.md"]);
    expect(l.outbound.map((r) => r.dstPath)).toEqual(["/substances/salt.md"]);
    expect(l.byName.map((r) => r.path)).toEqual(["/substances/salt.md"]);
    expect(s.names()).toEqual(["query", "query", "query"]);
    expect(s.argsOf("query", 0)).toEqual({ query: inboundQuery(P), limit: 500, repo: "alchemy" });
    expect(s.argsOf("query", 2)).toEqual({ query: byNameQuery(P), limit: 500, repo: "alchemy" });
  });
  it("resolves a wikilink by the path's tail", async () => {
    expect(wikilinkQuery("salt")).toBe('select _path from docs where _path.endsWith("/salt.md")');
    expect(wikilinkQuery("notes/one.md")).toBe('select _path from docs where _path.endsWith("/notes/one.md")');
    const s = new ScriptedCaller({ query: () => page([{ _id: "d_14", _path: "/substances/salt.md" }]) });
    expect(await resolveWikilink(s, "salt", null)).toEqual(["/substances/salt.md"]);
    expect(s.argsOf("query")).toEqual({ query: wikilinkQuery("salt"), limit: 10 });
  });
});
