// The editable hole of the framed filter, as CodeMirror state: the frame's
// mode and hole range (a StateField mapped through every change), the
// transaction filter that keeps edits inside the hole and off a new line, and
// the `reframe` effect that swaps the frame (with or without its `where` line,
// a new value from outside) in one whole-document transaction. Only
// @codemirror/state — no view, no DOM — so it is unit-tested with plain
// EditorStates (test/hole.test.ts).

import { EditorSelection, EditorState, StateEffect, StateField, type Extension, type Transaction, type TransactionSpec } from "@codemirror/state";
import { frameFor, type Frame } from "./feed.ts";

export interface Hole { from: number; to: number }

/** The field's value: the hole and whether the `where` line (and so any editing) exists. */
export interface HoleState extends Hole { where: boolean }

const holeOf = (f: Frame): HoleState => ({ ...f.hole, where: f.where });

/** Carried by a transaction that replaces the whole document with a new frame: the filter lets it through and the field takes the new hole. */
export const reframe = StateEffect.define<HoleState>();

/** The hole after a transaction's changes: an insertion at either end lands inside it, a deletion shrinks it. */
export function mapHole<H extends Hole>(hole: H, tr: Pick<Transaction, "changes">): H {
  return { ...hole, from: tr.changes.mapPos(hole.from, -1), to: tr.changes.mapPos(hole.to, 1) };
}

/** Does every changed range of this transaction lie inside the hole (as it was before the transaction)? */
export function changesInside(tr: Pick<Transaction, "changes">, hole: Hole): boolean {
  let inside = true;
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (fromA < hole.from || toA > hole.to) inside = false;
  });
  return inside;
}

/** Does this transaction insert a line break? (The hole is one line; the frame's own breaks are outside it.) */
export function insertsNewline(tr: Pick<Transaction, "changes">): boolean {
  let newline = false;
  tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    if (inserted.lines > 1) newline = true;
  });
  return newline;
}

/** The frame's mode and editable range (the element seeds it with `holeField.init`). */
export const holeField = StateField.define<HoleState>({
  create: () => holeOf(frameFor("")),
  update(hole, tr) {
    for (const e of tr.effects) if (e.is(reframe)) return e.value;
    return tr.docChanged ? mapHole(hole, tr) : hole;
  },
});

const clamp = (pos: number, hole: Hole) => Math.min(Math.max(pos, hole.from), hole.to);

/** Drop a change outside the hole, one that would break the where line, or any
 * change while there is no where line; pull a selection outside the hole to its
 * nearest end, so typing always lands where it can. A `reframe` passes as is. */
export const holeOnly = EditorState.transactionFilter.of((tr): TransactionSpec | readonly TransactionSpec[] => {
  if (tr.effects.some((e) => e.is(reframe))) return tr;
  const before = tr.startState.field(holeField);
  if (tr.docChanged && (!before.where || !changesInside(tr, before) || insertsNewline(tr))) return [];
  const after = tr.docChanged ? mapHole(before, tr) : before;
  const sel = tr.newSelection;
  if (sel.ranges.some((r) => r.from < after.from || r.to > after.to)) {
    return [tr, { selection: EditorSelection.create(sel.ranges.map((r) => EditorSelection.range(clamp(r.anchor, after), clamp(r.head, after))), sel.mainIndex) }];
  }
  return tr;
});

/** The one transaction that swaps the frame: the whole document becomes
 * `frameFor(filter, { editing })`, the caret goes to the end of the hole. */
export function reframeSpec(state: EditorState, filter: string, editing: boolean): TransactionSpec {
  const framed = frameFor(filter, { editing });
  return {
    changes: { from: 0, to: state.doc.length, insert: framed.text },
    selection: { anchor: framed.hole.to },
    effects: reframe.of(holeOf(framed)),
  };
}

/** The hole's text in a state. */
export function holeText(state: EditorState): string {
  const h = state.field(holeField);
  return state.doc.sliceString(h.from, h.to);
}

/** An EditorState over the frame for `filter` with the hole machinery installed (the element adds the view-side extensions). */
export function holeState(filter: string, { editing = false }: { editing?: boolean } = {}, extensions: Extension = []): EditorState {
  const framed = frameFor(filter, { editing });
  return EditorState.create({
    doc: framed.text,
    selection: { anchor: framed.hole.to },
    extensions: [holeField.init(() => holeOf(framed)), holeOnly, extensions],
  });
}
