// The Focus pointer: `/attn/focus.md`, read whole with `docs_read` because
// the write that follows needs its `rev` — `expect.revision` on the pointer's
// `set` effects is the CAS that keeps two devices from both switching blindly
// (spec/mutate §11.2: a different current_rev is `stale_plan`). Its frontmatter:
// `focused_intent` (an intent path or null), `since` (ISO), `return_stack`
// (intent paths, top last — what `interrupt` displaced; the design note leaves
// suspend/defer open, so the stack is an extra field on this one document and
// nothing else is written). A workspace without the document is a workspace
// that never focused anything: `exists: false`, and the first switch creates it.

import { OmgError, repoArg, type Caller, type Wire } from "./mcp-client.ts";
import { POINTER_PATH, record, str, strList, strOrNull } from "./model.ts";

/** What the pointer says: the intent in focus, since when, and the interrupt stack. */
export interface PointerState {
  /** The intent in focus (its `/`-rooted path), or null. */
  focused: string | null;
  /** When it took focus (ISO), or null when the pointer never carried one. */
  since: string | null;
  /** The interrupt return stack, top last. */
  returnStack: string[];
}

export interface FocusState extends PointerState {
  /** The pointer document exists (false ⇒ the first write must `create` it). */
  exists: boolean;
  docId: string | null;
  /** The pointer's current revision — the CAS token of the next switch. */
  rev: string | null;
}

export const NO_FOCUS: FocusState = { exists: false, docId: null, rev: null, focused: null, since: null, returnStack: [] };

/** A frontmatter bag (live `properties.frontmatter`, or `frontmatterOf(raw)` at a revision) → the state. */
export function pointerStateOf(fm: Record<string, unknown>): PointerState {
  return { focused: strOrNull(fm.focused_intent), since: strOrNull(fm.since), returnStack: strList(fm.return_stack) };
}

/** `docs_read` of the pointer → the state. */
export function pointerOf(wire: Wire): FocusState {
  const fm = record(record(wire.properties).frontmatter);
  return { exists: true, docId: str(wire._id) || null, rev: str(wire.rev) || null, ...pointerStateOf(fm) };
}

/** `docs_read { _path: "/attn/focus.md" }` (the argument addresses the row's `_path`, surface 5.0); `doc_missing` is "never focused anything". */
export async function fetchPointer(caller: Caller, repo: string | null): Promise<FocusState> {
  try {
    return pointerOf(await caller.call<Wire>("docs_read", { _path: POINTER_PATH, ...repoArg(repo) }));
  } catch (e) {
    if (e instanceof OmgError && e.code === "doc_missing") return NO_FOCUS;
    throw e;
  }
}

/** One focus episode's identity: the intent and the moment it took focus. The
 * cue dedupe ("once per cue per episode") and the snooze boundary key on it; null when nothing is in focus. */
export function episodeKey(p: Pick<PointerState, "focused" | "since">): string | null {
  return p.focused ? `${p.focused}@${p.since ?? ""}` : null;
}

/** The return target `back` would resume (the top of the stack), or null. */
export function returnTarget(p: Pick<PointerState, "returnStack">): string | null {
  return p.returnStack.length ? p.returnStack[p.returnStack.length - 1]! : null;
}
