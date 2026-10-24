// Task checkboxes: the pure side of the write-back and its session-local undo.
//
// A task is a list item block whose first paragraph opens with the GFM marker
// (`[ ]`, `[x]` or `[X]` followed by whitespace) — the rule remark gives the
// engine (`listItem.checked`), so the store types it `task` and reads the state
// as the bare attr `checked`. Toggling it is ONE effect over `apply` (spec/mutate
// §11.2): `{ op: "set", target: { kind: "block", _id }, field: "_attrs.checked",
// value, expect: { content_hash } }` — the hash is the block's from `docs_read {
// include_ids }` (`hashes[id]`, the sha256 of its raw), the CAS token, so the
// write lands only on the bytes the page rendered. A block that moved on fails
// `stale_expectation` (the kernel's check at plan time, `data.current._hash`),
// `stale_plan` (the document changed between plan and commit inside `apply`) or
// `plan_mismatch`; the page re-reads and asks for another click.
//
// Undo is compensation, not history rewriting: the page runs each toggle as
// `@omgbase/client`'s `taskCheckCommand` on the shared `CommandLog`, which
// remembers the block's hash before and after the write and undoes by a NEW
// `apply` that sets the attr back, pinned to the hash the toggle left —
// refused when the block's current hash is not that one (someone else wrote
// the block; an undo would overwrite their change). Redo re-reads the same way.

import type { OmgError } from "./mcp-client.ts";
import type { Effect } from "./writes.ts";

// ---- the marker ----------------------------------------------------------------------------

/** The GFM task marker at the start of a list item's inline content: `[ ]`, `[x]` or `[X]` then whitespace. */
const MARKER = /^\[([ xX])\][ \t]/;

export interface TaskMarker {
  checked: boolean;
  /** How many characters the marker and its one following space take (`[x] ` → 4). */
  length: number;
}

/** The task marker opening `text`, or null when the text is not a task. */
export function taskMarker(text: string): TaskMarker | null {
  const m = MARKER.exec(text);
  if (!m) return null;
  return { checked: m[1] !== " ", length: m[0].length };
}

// ---- the effect ----------------------------------------------------------------------------

/** `set _attrs.checked = <checked>` on a block, pinned to its current hash (the CAS). */
export function setCheckedEffect(blockId: string, checked: boolean, contentHash: string): Effect {
  return { op: "set", target: { kind: "block", _id: blockId }, field: "_attrs.checked", value: checked, expect: { content_hash: contentHash } };
}

/** The error codes that mean "the block or its document changed since it was read" (spec/mutate §1.2, §11.7). */
export const MOVED_ON_CODES: ReadonlySet<string> = new Set(["stale_expectation", "stale_plan", "plan_mismatch"]);

export function isMovedOn(e: unknown): e is OmgError {
  return typeof e === "object" && e !== null && "code" in e && typeof (e as { code: unknown }).code === "string" && MOVED_ON_CODES.has((e as { code: string }).code);
}

/** What the page says when a toggle lost the race. */
export const MOVED_ON_MESSAGE = "the document changed since it was read — refreshed; try again";

// ---- why a box is disabled -------------------------------------------------------------------

export interface TaskGate {
  /** The server lists `apply`. */
  canApply: boolean;
  /** The item's block pairing: verified, placed but unverified, or absent. */
  anchor: "verified" | "unverified" | "none";
}

/** Null when the checkbox may be toggled; else the reason shown as its title. */
export function taskDisabledReason(gate: TaskGate): string | null {
  if (!gate.canApply) return "read-only: this server does not list `apply`";
  if (gate.anchor === "none") return "this item has no block anchor (its level did not pair with the store's ids) — not editable here";
  if (gate.anchor === "unverified") return "this item's block could not be verified against the store (its raw did not hash to the stored hash) — not editable here";
  return null;
}
