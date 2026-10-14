import { describe, expect, it } from "vitest";
import { byNameQuery, fetchLinks, inboundQuery, linkProvenance, linkRowsOf, linkTarget, outboundQuery, resolveWikilink, wikiStem, wikilinkQuery } from "../src/lib/links.ts";
import { ScriptedCaller, page } from "./scripted.ts";

const P = "/processes/calcination.md";

describe("the two link queries", () => {
  it("inbound: links whose dst_path is the document; outbound: links whose path (the source) is", () => {
    expect(inboundQuery(P)).toBe('select path, block_id, provenance, field, anchor from links where dst_path == "/processes/calcination.md"');
    expect(outboundQuery("processes/calcination.md")).toBe('select dst_path, dst_id, dst_kind, uri, provenance, field, anchor from links where path == "/processes/calcination.md"');
  });
  it("by name: the unresolved [[wikilinks]] naming the document (dst_id is phantom:<stem>)", () => {
    expect(wikiStem("/substances/salt.md")).toBe("salt");
    expect(wikiStem("/x/no-extension")).toBe("no-extension");
    expect(byNameQuery("/substances/salt.md")).toBe('select path, block_id, provenance, field, anchor from links where dst_id == "phantom:salt"');
  });
  it("reads link rows as the server spells them (a wikilink naming no document has dst_path null)", () => {
    const rows = linkRowsOf([
      { id: "e_1", path: "/index.md", block_id: "b_8", dst_path: P, provenance: "link", field: null, anchor: null, uri: null, dst_kind: "document" },
      { id: "e_2", path: P, dst_path: null, dst_id: "phantom:salt", dst_kind: "document", provenance: "link", anchor: null, uri: null, field: null },
      { id: "e_3", path: P, dst_path: null, dst_id: "x_1", dst_kind: "external", provenance: "frontmatter", field: "homepage", uri: "https://example.com/" },
      { id: "e_4", dst_path: P },
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
        if (q.includes("dst_path ==")) return page([{ id: "e_1", path: "/index.md", block_id: "b_8", provenance: "link" }]);
        if (q.includes("dst_id ==")) return page([{ id: "e_3", path: "/substances/salt.md", block_id: "b_9", provenance: "link" }]);
        return page([{ id: "e_2", path: P, dst_path: "/substances/salt.md", dst_kind: "document", provenance: "link" }]);
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
    expect(wikilinkQuery("salt")).toBe('select path from docs where path.endsWith("/salt.md")');
    expect(wikilinkQuery("notes/one.md")).toBe('select path from docs where path.endsWith("/notes/one.md")');
    const s = new ScriptedCaller({ query: () => page([{ id: "d_14", path: "/substances/salt.md" }]) });
    expect(await resolveWikilink(s, "salt", null)).toEqual(["/substances/salt.md"]);
    expect(s.argsOf("query")).toEqual({ query: wikilinkQuery("salt"), limit: 10 });
  });
});
