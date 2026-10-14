import { describe, expect, it } from "vitest";
import { blockIdsOf, docAtOf, docReadOf, docTitle, fetchDocument, fetchDocumentAt, propertyRows, splitFrontmatter, valueText } from "../src/lib/document.ts";
import { ScriptedCaller } from "./scripted.ts";

const RAW = "---\ntype: process\ntags: [process, fire]\nverified: true\n---\n\n# Calcination\n\nHeating.\n";

const WIRE = {
  id: "d_7", path: "processes/calcination.md", rev: "r_7",
  properties: { frontmatter: { type: "process", tags: ["process", "fire"], verified: true }, inline: { element: "fire" }, computed: { title: "Calcination" } },
  raw: RAW,
  ids: ["b_1", "b_2"], hashes: { b_1: "aa", b_2: "bb" }, parents: { b_1: null, b_2: null },
};

describe("docs_read → DocRead", () => {
  it("reads the shape, roots the path, keeps the ids map", () => {
    const d = docReadOf(WIRE);
    expect(d).toMatchObject({ id: "d_7", path: "/processes/calcination.md", rev: "r_7", raw: RAW });
    expect(d.blockIds).toEqual({ ids: ["b_1", "b_2"], hashes: { b_1: "aa", b_2: "bb" }, parents: { b_1: null, b_2: null } });
    expect(docTitle(d)).toBe("Calcination");
    expect(docTitle({ ...d, properties: { ...d.properties, computed: {} } })).toBe("calcination.md");
  });
  it("has no ids without include_ids, and tolerates a malformed bag", () => {
    const { ids: _i, hashes: _h, parents: _p, ...plain } = WIRE;
    expect(docReadOf(plain).blockIds).toBeNull();
    expect(blockIdsOf({ ids: ["b_1", 3], parents: { b_1: 7 }, hashes: { b_1: 1 } })).toEqual({ ids: ["b_1"], parents: { b_1: null }, hashes: {} });
    expect(docReadOf({ properties: "nope" }).properties).toEqual({ frontmatter: {}, inline: {}, computed: {} });
  });
  it("docs_read { at } → DocAt", () => {
    expect(docAtOf({ id: "d_0", path: "guide.md", rev: "r_0", raw: "# G\n", renderedHashMatch: true })).toEqual({ id: "d_0", path: "/guide.md", rev: "r_0", raw: "# G\n", renderedHashMatch: true });
  });
});

describe("the property table", () => {
  it("lists frontmatter, then inline, then computed; strings as they are, the rest as JSON", () => {
    const rows = propertyRows(docReadOf(WIRE).properties);
    expect(rows.map((r) => [r.source, r.key, r.text])).toEqual([
      ["frontmatter", "type", "process"],
      ["frontmatter", "tags", '["process","fire"]'],
      ["frontmatter", "verified", "true"],
      ["inline", "element", "fire"],
      ["computed", "title", "Calcination"],
    ]);
    expect(valueText(null)).toBe("null");
    expect(valueText(undefined)).toBe("");
    expect(valueText({ a: 1 })).toBe('{"a":1}');
  });
});

describe("splitFrontmatter", () => {
  it("separates the YAML fence from the body and says where the body starts", () => {
    expect(splitFrontmatter(RAW)).toEqual({ frontmatter: "type: process\ntags: [process, fire]\nverified: true", body: "\n# Calcination\n\nHeating.\n", bodyLine: 5 });
    expect(splitFrontmatter("# No fence\n")).toEqual({ frontmatter: null, body: "# No fence\n", bodyLine: 0 });
    expect(splitFrontmatter("---\nunterminated\n# x")).toEqual({ frontmatter: null, body: "---\nunterminated\n# x", bodyLine: 0 });
    expect(splitFrontmatter("---\na: 1\n...\nbody")).toEqual({ frontmatter: "a: 1", body: "body", bodyLine: 3 });
  });
});

describe("the reads over a scripted minimal server", () => {
  it("fetchDocument is docs_read { id | path, include_ids: true } (+ repo when chosen)", async () => {
    const s = new ScriptedCaller({ docs_read: () => WIRE });
    await fetchDocument(s, { path: "/processes/calcination.md" }, null);
    await fetchDocument(s, { id: "d_7" }, "alchemy");
    expect(s.calls).toEqual([
      { name: "docs_read", args: { path: "/processes/calcination.md", include_ids: true } },
      { name: "docs_read", args: { id: "d_7", include_ids: true, repo: "alchemy" } },
    ]);
  });
  it("fetchDocumentAt is docs_read { id | path, at } — never docs_read_at", async () => {
    const s = new ScriptedCaller({ docs_read: () => ({ id: "d_7", path: "/processes/calcination.md", rev: "r_7", raw: "# Old\n", renderedHashMatch: true }) });
    const at = await fetchDocumentAt(s, { id: "d_7" }, "r_7", null);
    expect(at.raw).toBe("# Old\n");
    expect(s.calls).toEqual([{ name: "docs_read", args: { id: "d_7", at: "r_7" } }]);
  });
});
