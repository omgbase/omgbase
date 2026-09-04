import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTree } from "../../src/core/parse/tree.js";
import { assignIds } from "../../src/core/store/writers.js";
import { reconcileDocument } from "../../src/reconcile/reconcile.js";
import { flatten, fromInput, type FlatSource } from "../../src/reconcile/flatten.js";

const dir = fileURLToPath(new URL("./fixtures/brief-example/", import.meta.url));

function read(file: string): string {
  return readFileSync(new URL(file, `file://${dir}`), "utf8");
}

// Old side: parse + mint ids (as if previously ingested).
function parseOld(file: string): FlatSource[] {
  const blocks = parseTree(read(file)).children.filter((b) => b.type !== "frontmatter");
  return fromInput(assignIds(blocks));
}

// New side: parse without ids (a fresh edit the matcher must reconcile).
function parseNew(file: string): FlatSource[] {
  const blocks = parseTree(read(file)).children.filter((b) => b.type !== "frontmatter");
  return blocks.map((b) => ({ type: b.type, raw: b.raw, children: [] }));
}

describe("brief-example fixture (03 §10)", () => {
  it("insertion mints; the edited paragraph carries the old id via context/scored", () => {
    const oldFlat = flatten(parseOld("old.md"));
    const newFlat = flatten(parseNew("new.md"));

    const headingId = oldFlat.find((b) => b.type === "heading")!.blockId!;
    const p1Id = oldFlat.find((b) => b.text === "Stable block identity is difficult.")!.blockId!;
    const p2Id = oldFlat.find((b) => b.text === "Another paragraph.")!.blockId!;

    const res = reconcileDocument(oldFlat, newFlat);

    const byKey = (key: string): string => res.assignment.get(key)!;

    // /0 heading, /1 inserted, /2 edited (carries p1), /3 Another (carries p2)
    expect(byKey("/0")).toBe(headingId);
    expect(byKey("/3")).toBe(p2Id);
    expect(byKey("/2")).toBe(p1Id);

    const insertedId = byKey("/1");
    expect(insertedId).not.toBe(p1Id);
    expect(res.dispositions.find((d) => d.blockId === insertedId)!.kind).toBe("inserted");

    // The carry of p1 is a high-confidence edit (context propagation), not
    // "same" (content changed) and not an identity theft by the insertion.
    // p1 shifted from index 1 to 2 (insertion pushed it down) and its text
    // changed → edited_moved, carried by context propagation.
    const p1Disp = res.dispositions.find((d) => d.blockId === p1Id)!;
    expect(p1Disp.kind).toBe("edited_moved");
    expect(p1Disp.reason).toBe("context_unique");
    expect(p1Disp.confidence).toBeGreaterThanOrEqual(0.8);
  });
});
