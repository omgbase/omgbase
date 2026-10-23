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
// Undo is compensation, not history rewriting: each completed toggle is
// remembered with the block's hash before and after the write, and undoing it
// is a NEW `apply` that sets the attr back, pinned to `hashAfter` — refused
// outright (`compensation`) when the block's current hash is not the one the
// toggle left, because then someone else wrote the block and an undo would
// overwrite their change. Redo is the same with the roles swapped. The log is
// plain data (`ToggleLog`, two stacks) so it can later ride on the shared
// `@omgbase/client` command log without a rewrite.

import type { OmgError } from "./mcp-client.ts";
import type { Effect, Receipt } from "./writes.ts";

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

// ---- the log ---------------------------------------------------------------------------------

export interface ToggleRecord {
  blockId: string;
  /** The document's rooted path. */
  path: string;
  from: boolean;
  to: boolean;
  /** The block's hash when the toggle was sent (the CAS it carried) — the hash redo expects. */
  hashBefore: string;
  /** The block's hash after the write (from the re-read) — the hash undo expects. */
  hashAfter: string;
  receipt: Receipt;
}

export interface ToggleLog {
  /** Toggles in effect, oldest first; the last is the next to undo. */
  done: ToggleRecord[];
  /** Toggles undone, the last is the next to redo. */
  undone: ToggleRecord[];
}

/** How many completed toggles are remembered (the oldest fall off). */
export const LOG_CAP = 50;

export const EMPTY_LOG: ToggleLog = { done: [], undone: [] };

/** A fresh toggle: pushed, the redo stack cleared (a new write makes the undone toggles unreachable). */
export function pushToggle(log: ToggleLog, rec: ToggleRecord): ToggleLog {
  return { done: [...log.done, rec].slice(-LOG_CAP), undone: [] };
}

export type Direction = "undo" | "redo";

/** The toggle an undo (or redo) would compensate, or null. */
export function nextToggle(log: ToggleLog, dir: Direction): ToggleRecord | null {
  const stack = dir === "undo" ? log.done : log.undone;
  return stack[stack.length - 1] ?? null;
}

export type Compensation =
  | { ok: true; effect: Effect; value: boolean; expectedHash: string }
  | { ok: false; reason: string };

/** The compensating effect for `rec` in `dir`, given the block's CURRENT hash
 * (undefined when the block is no longer in the document's ids) — or the
 * refusal. Undo expects `hashAfter` and sets `from`; redo expects
 * `hashBefore` and sets `to`. Never overwrite: a hash that is not the one
 * the toggle left means another write happened since. */
export function compensation(rec: ToggleRecord, currentHash: string | undefined, dir: Direction): Compensation {
  const expectedHash = dir === "undo" ? rec.hashAfter : rec.hashBefore;
  const value = dir === "undo" ? rec.from : rec.to;
  if (currentHash === undefined) {
    return { ok: false, reason: `cannot ${dir}: block ${rec.blockId} is no longer in ${rec.path} (removed or re-identified since the toggle)` };
  }
  if (currentHash !== expectedHash) {
    return { ok: false, reason: `cannot ${dir}: block ${rec.blockId} in ${rec.path} changed since the toggle (expected hash ${expectedHash.slice(0, 12)}…, now ${currentHash.slice(0, 12)}…) — not overwriting someone else's edit` };
  }
  return { ok: true, effect: setCheckedEffect(rec.blockId, value, expectedHash), value, expectedHash };
}

/** The log after a compensation in `dir` landed: the record moves to the other
 * stack with the hash the compensation left (`hashNow`, from the re-read) in the
 * slot the opposite direction will expect — after an undo the block is at
 * `hashBefore` again (possibly a new value: `[X]` normalises to `[x]`), so redo
 * expects THAT; after a redo, `hashAfter`. */
export function afterCompensation(log: ToggleLog, rec: ToggleRecord, dir: Direction, hashNow: string): ToggleLog {
  if (dir === "undo") {
    return { done: log.done.filter((r) => r !== rec), undone: [...log.undone, { ...rec, hashBefore: hashNow }] };
  }
  return { done: [...log.done, { ...rec, hashAfter: hashNow }].slice(-LOG_CAP), undone: log.undone.filter((r) => r !== rec) };
}

/** The affordance's label: `undo: uncheck "b_12" in /a.md` (what the compensation would do). */
export function toggleLabel(rec: ToggleRecord | null, dir: Direction): string | null {
  if (!rec) return null;
  const value = dir === "undo" ? rec.from : rec.to;
  return `${dir}: ${value ? "check" : "uncheck"} ${rec.blockId} in ${rec.path}`;
}
