import { describe, expect, it } from "vitest";
import {
  blockTarget, createDocument, documentTarget, insertMarkdown, moveBlocks, moveDocument, newSymbol, nodeTarget, removeBlocks, removeDocument,
  sectionTarget, setBlockAttr, setBlockMarkdown, setContent, setFrontmatter, unsetFrontmatter,
} from "./effects.js";

describe("targets", () => {
  it("spell the explicit forms exactly", () => {
    expect(documentTarget("/a/b.md")).toEqual({ kind: "document", _path: "/a/b.md" });
    expect(documentTarget({ _id: "d_1" })).toEqual({ kind: "document", _id: "d_1" });
    expect(documentTarget({ _path: "a/b.md" })).toEqual({ kind: "document", _path: "a/b.md" });
    expect(documentTarget({ kind: "document", _id: "d_2" })).toEqual({ kind: "document", _id: "d_2" });
    expect(blockTarget("b_1")).toEqual({ kind: "block", _id: "b_1" });
    expect(nodeTarget("n_1")).toEqual({ kind: "node", _id: "n_1" });
    expect(sectionTarget("b_9")).toEqual({ kind: "section", heading_id: "b_9" });
    expect(newSymbol(0)).toBe("$new.0");
  });
});

describe("block effects", () => {
  it("setBlockAttr: _attrs.checked with the hash guard only when given", () => {
    expect(setBlockAttr("b_1", "checked", true, { contentHash: "h_1" })).toEqual({ op: "set", target: { kind: "block", _id: "b_1" }, field: "_attrs.checked", value: true, expect: { content_hash: "h_1" } });
    expect(setBlockAttr("b_1", "checked", false)).toEqual({ op: "set", target: { kind: "block", _id: "b_1" }, field: "_attrs.checked", value: false });
  });
  it("setBlockMarkdown, removeBlocks, moveBlocks", () => {
    expect(setBlockMarkdown("b_1", "- [ ] x", { contentHash: "h" })).toEqual({ op: "set", target: { kind: "block", _id: "b_1" }, field: "markdown", value: "- [ ] x", expect: { content_hash: "h" } });
    expect(removeBlocks(["b_1", "b_2"], { b_1: { content_hash: "h1" } })).toEqual({ op: "remove", targets: [{ kind: "block", _id: "b_1" }, { kind: "block", _id: "b_2" }], expect: { b_1: { content_hash: "h1" } } });
    expect(removeBlocks(["b_1"])).toEqual({ op: "remove", targets: [{ kind: "block", _id: "b_1" }] });
    expect(moveBlocks(["b_1"], "/a.md", "end", { parentChildrenHash: "p" })).toEqual({ op: "move", targets: [{ kind: "block", _id: "b_1" }], into: { kind: "document", _path: "/a.md" }, at: "end", expect: { parent_children_hash: "p" } });
    expect(moveBlocks(["b_1"], blockTarget("b_7"), { after: "b_8" })).toEqual({ op: "move", targets: [{ kind: "block", _id: "b_1" }], into: { kind: "block", _id: "b_7" }, at: { after: "b_8" } });
  });
  it("insertMarkdown into a document, a block, a section or a $new symbol", () => {
    expect(insertMarkdown("/a.md", "end", "## New")).toEqual({ op: "insert", into: { kind: "document", _path: "/a.md" }, at: "end", markdown: "## New" });
    expect(insertMarkdown(blockTarget("b_1"), "start", "- x", { parentChildrenHash: "p" })).toEqual({ op: "insert", into: { kind: "block", _id: "b_1" }, at: "start", markdown: "- x", expect: { parent_children_hash: "p" } });
    expect(insertMarkdown(sectionTarget("b_2"), { before: "b_3" }, "x")).toEqual({ op: "insert", into: { kind: "section", heading_id: "b_2" }, at: { before: "b_3" }, markdown: "x" });
    expect(insertMarkdown("$new.0", "end", "Hi.")).toEqual({ op: "insert", into: "$new.0", at: "end", markdown: "Hi." });
  });
});

describe("document effects", () => {
  it("frontmatter set/unset with the revision guard only when given", () => {
    expect(setFrontmatter("/a.md", "status", "done", { revision: "r_1" })).toEqual({ op: "set", target: { kind: "document", _path: "/a.md" }, field: "_frontmatter.status", value: "done", expect: { revision: "r_1" } });
    expect(setFrontmatter({ _id: "d_1" }, "tags", ["a"])).toEqual({ op: "set", target: { kind: "document", _id: "d_1" }, field: "_frontmatter.tags", value: ["a"] });
    expect(unsetFrontmatter("/a.md", "status", { revision: "r_2" })).toEqual({ op: "unset", target: { kind: "document", _path: "/a.md" }, field: "_frontmatter.status", expect: { revision: "r_2" } });
  });
  it("setContent, createDocument, moveDocument, removeDocument", () => {
    expect(setContent("/a.md", "# A\n", { revision: "r" })).toEqual({ op: "set", target: { kind: "document", _path: "/a.md" }, field: "content", value: "# A\n", expect: { revision: "r" } });
    expect(createDocument("lab/march.md", "# March\n")).toEqual({ op: "create", path: "lab/march.md", markdown: "# March\n" });
    expect(createDocument("lab/march.md", "# March\n", { stage: "x" })).toEqual({ op: "create", path: "lab/march.md", markdown: "# March\n", frontmatter: { stage: "x" } });
    expect(moveDocument("/a.md", "b/a.md", { retargetInbound: true })).toEqual({ op: "move", target: { kind: "document", _path: "/a.md" }, to: "b/a.md", retarget_inbound: true });
    expect(moveDocument({ _id: "d_1" }, "b/a.md")).toEqual({ op: "move", target: { kind: "document", _id: "d_1" }, to: "b/a.md" });
    expect(removeDocument("/a.md")).toEqual({ op: "remove", target: { kind: "document", _path: "/a.md" } });
  });
});
