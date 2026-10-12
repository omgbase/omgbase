import { describe, expect, it } from "vitest";
import { FRAME_AFTER, FRAME_BEFORE, frameFor, recentQuery } from "../src/lib/feed.ts";
import { changesInside, holeField, holeState, holeText, mapHole, reframeSpec } from "../src/lib/hole.ts";

describe("the framed filter's hole", () => {
  it("starts as the three-line frame with the filter in the hole, cursor at its end", () => {
    const s = holeState('status == "active"');
    expect(s.doc.toString()).toBe(frameFor('status == "active"').text);
    expect(s.doc.lines).toBe(3);
    expect(s.doc.line(2).text).toBe('where status == "active"');
    expect(s.doc.toString().replace(/\n/g, " ")).toBe(recentQuery('status == "active"'));
    expect(holeText(s)).toBe('status == "active"');
    expect(s.field(holeField).where).toBe(true);
    expect(s.selection.main.head).toBe(FRAME_BEFORE.length + 'status == "active"'.length);
  });
  it("grows with insertions inside it, including at either end, and shrinks with deletions", () => {
    let s = holeState("a");
    const h = s.field(holeField);
    s = s.update({ changes: { from: h.to, insert: " == 1" } }).state; // at the end
    expect(holeText(s)).toBe("a == 1");
    s = s.update({ changes: { from: s.field(holeField).from, insert: "not " } }).state; // at the start
    expect(holeText(s)).toBe("not a == 1");
    s = s.update({ changes: { from: s.field(holeField).from, to: s.field(holeField).from + 4 } }).state; // delete "not "
    expect(holeText(s)).toBe("a == 1");
    expect(s.doc.toString()).toBe(`${FRAME_BEFORE}a == 1${FRAME_AFTER}`);
    const empty = holeState("", { editing: true });
    const grown = empty.update({ changes: { from: empty.field(holeField).from, insert: "x" } }).state; // an empty hole accepts the first character
    expect(holeText(grown)).toBe("x");
  });
  it("drops a transaction whose changes touch the frame: before, after, straddling, or the whole document", () => {
    const s = holeState("a == 1");
    const h = s.field(holeField);
    const unchanged = (tr: { docChanged: boolean; state: typeof s }) => { expect(tr.docChanged).toBe(false); expect(tr.state.doc.toString()).toBe(s.doc.toString()); };
    unchanged(s.update({ changes: { from: 0, insert: "x" } }));
    unchanged(s.update({ changes: { from: h.from - 1, to: h.from } })); // backspace at the hole's start eats the frame
    unchanged(s.update({ changes: { from: h.to, to: h.to + 1 } })); // delete at its end
    unchanged(s.update({ changes: { from: h.from - 3, to: h.from + 1, insert: "q" } })); // straddling
    unchanged(s.update({ changes: { from: 0, to: s.doc.length, insert: "select 1 from docs" } })); // select-all + type
    unchanged(s.update({ changes: { from: s.doc.length, insert: " offset 5" } })); // appending to the frame
    // The same, as the view would ask them, is what changesInside answers.
    expect(changesInside(s.update({ changes: { from: h.from, to: h.to, insert: "b" } }, { filter: false }), h)).toBe(true);
    expect(changesInside(s.update({ changes: { from: 0, insert: "x" } }, { filter: false }), h)).toBe(false);
  });
  it("rejects a newline in the hole (the where line stays one line; the frame's own newlines are outside it)", () => {
    const s = holeState("a == 1");
    const h = s.field(holeField);
    expect(s.update({ changes: { from: h.to, insert: "\n and b" } }).docChanged).toBe(false);
    expect(s.update({ changes: { from: h.from, insert: "\n" } }).docChanged).toBe(false);
    expect(s.update({ changes: { from: h.from - 1, to: h.from, insert: "" } }).docChanged).toBe(false); // joining with line 1 touches the frame
    const ok = s.update({ changes: { from: h.to, insert: " and b" } });
    expect(ok.docChanged).toBe(true);
    expect(ok.state.doc.lines).toBe(3);
  });
  it("moves a selection that lands in the frame to the nearest end of the hole", () => {
    const s = holeState("a == 1");
    const h = s.field(holeField);
    expect(s.update({ selection: { anchor: 3 } }).state.selection.main.head).toBe(h.from);
    expect(s.update({ selection: { anchor: s.doc.length } }).state.selection.main.head).toBe(h.to);
    expect(s.update({ selection: { anchor: h.from + 2 } }).state.selection.main.head).toBe(h.from + 2);
    const range = s.update({ selection: { anchor: 0, head: s.doc.length } }).state.selection.main; // select all → the hole
    expect([range.from, range.to]).toEqual([h.from, h.to]);
  });
  it("idle and empty: two lines, no where, and nothing is editable until a reframe opens the where line", () => {
    const idle = holeState("");
    expect(idle.doc.lines).toBe(2);
    expect(idle.doc.toString()).toBe(frameFor("").text);
    expect(idle.field(holeField).where).toBe(false);
    const h = idle.field(holeField);
    expect(idle.update({ changes: { from: h.from, insert: "x" } }).docChanged).toBe(false); // even at the closed hole
    expect(idle.update({ changes: { from: idle.doc.length, insert: " where x" } }).docChanged).toBe(false);
    // focus → the editing frame, caret after `where `
    const editing = idle.update(reframeSpec(idle, "", true)).state;
    expect(editing.doc.lines).toBe(3);
    expect(editing.doc.line(2).text).toBe("where ");
    expect(editing.field(holeField)).toEqual({ from: FRAME_BEFORE.length, to: FRAME_BEFORE.length, where: true });
    expect(editing.selection.main.head).toBe(FRAME_BEFORE.length);
    const typed = editing.update({ changes: { from: FRAME_BEFORE.length, insert: "a" } }).state;
    expect(holeText(typed)).toBe("a");
    // blur with an empty hole → back to two lines
    const emptied = typed.update({ changes: { from: FRAME_BEFORE.length, to: FRAME_BEFORE.length + 1 } }).state;
    expect(holeText(emptied)).toBe("");
    expect(emptied.doc.lines).toBe(3); // still focused: the line stays so the caret has somewhere to be
    const back = emptied.update(reframeSpec(emptied, holeText(emptied), false)).state;
    expect(back.doc.toString()).toBe(frameFor("").text);
    expect(back.field(holeField).where).toBe(false);
  });
  it("a reframe replaces the whole document and takes the new hole; a filled frame stays three lines when idle", () => {
    const s = holeState("a == 1");
    const next = s.update(reframeSpec(s, "", true)).state;
    expect(next.doc.toString()).toBe(frameFor("", { editing: true }).text);
    expect(holeText(next)).toBe("");
    const filledIdle = next.update(reframeSpec(next, 'b == "x"', false)).state;
    expect(filledIdle.doc.lines).toBe(3);
    expect(holeText(filledIdle)).toBe('b == "x"');
    expect(filledIdle.field(holeField).where).toBe(true);
  });
  it("mapHole: an insertion at a boundary lands inside", () => {
    const s = holeState("ab");
    const h = s.field(holeField);
    const tr = s.update({ changes: [{ from: h.from, insert: "x" }, { from: h.to, insert: "y" }] });
    expect(mapHole(h, tr)).toEqual({ from: h.from, to: h.to + 2, where: true });
    expect(holeText(tr.state)).toBe("xaby");
  });
  it("spells the frame with the bare attributes; a reframe keeps the hole's text", () => {
    const s = holeState('status == "active"');
    expect(s.doc.toString()).toBe("select path, title, updated_at from docs\nwhere status == \"active\"\norder by updated_at desc limit 25");
    expect(holeText(s)).toBe('status == "active"');
    expect(s.selection.main.head).toBe(FRAME_BEFORE.length + 'status == "active"'.length);
    const reframed = s.update(reframeSpec(s, holeText(s), false)).state;
    expect(reframed.doc.toString()).toBe(s.doc.toString());
    expect(holeText(reframed)).toBe('status == "active"');
  });
});
