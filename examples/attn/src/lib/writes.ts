// Every mutation attn makes is ONE `apply { effects }` (or `plan` → `execute`),
// so it is atomic. SWITCHING FOCUS WRITES THE POINTER ONLY: `set
// frontmatter.focused_intent` / `since` (/ `return_stack`) on `/attn/focus.md`
// — no intent is touched, no log is appended (the history is the pointer's own
// revisions, lib/history.ts). Declaring an intent is its `create`; declaring
// and focusing it is the `create` plus the pointer's `set`s in the same
// request. CAS: the pointer's first `set` carries `expect.revision` = the
// pointer's `rev` as last read, so a switch made from another device between
// the read and this write is `stale_plan` (its `fix` is the same request
// re-pinned — the app shows it rather than taking it).
//
// The Receipt shapes and plan/execute helpers follow repo-explorer's lib/writes.ts.

import { repoArg, type Caller, type Wire } from "./mcp-client.ts";
import { INTENT_TYPE, POINTER_PATH, STATE_TYPE, nowIso } from "./model.ts";
import { returnTarget, type FocusState } from "./pointer.ts";

export type Effect = Record<string, unknown>;

/** What a switch needs to know: the pointer as last read and the clock. */
export interface SwitchContext {
  pointer: FocusState;
  /** The moment of the switch (ISO, UTC); defaults to the real clock. */
  now?: string;
}

/** The pointer's body: what the document is, in two sentences. */
export const POINTER_BODY = "# Current focus\n\nThis document records attn's current focus, shared across every client: `focused_intent` is the intent receiving attention (or null) and `since` when it took focus. Switching focus updates this pointer, never the intent; `return_stack` is what an interrupt displaced, top last.\n";

export interface PointerPatch {
  focused: string | null;
  since: string;
  /** Omitted ⇒ the stack is left as it is. */
  returnStack?: string[];
}

/** The pointer's writes: `set`s under CAS when the document exists (the first
 * carries `expect.revision`), one `create` when it does not. */
export function pointerEffects(ctx: SwitchContext, patch: PointerPatch): Effect[] {
  const p = ctx.pointer;
  if (!p.exists) {
    return [{
      op: "create",
      path: POINTER_PATH,
      markdown: POINTER_BODY,
      frontmatter: { type: STATE_TYPE, layer: "draft", focused_intent: patch.focused, since: patch.since, return_stack: patch.returnStack ?? [] },
    }];
  }
  const expect = p.rev ? { expect: { revision: p.rev } } : {};
  const out: Effect[] = [
    { op: "set", target: POINTER_PATH, field: "frontmatter.focused_intent", value: patch.focused, ...expect },
    { op: "set", target: POINTER_PATH, field: "frontmatter.since", value: patch.since },
  ];
  if (patch.returnStack !== undefined) out.push({ op: "set", target: POINTER_PATH, field: "frontmatter.return_stack", value: patch.returnStack });
  return out;
}

/** An ordinary switch: the pointer's `focused_intent` and `since` (the return stack is untouched). */
export function switchEffects(ctx: SwitchContext, target: string): Effect[] {
  return pointerEffects(ctx, { focused: target, since: ctx.now ?? nowIso() });
}

/** `interrupt`: like a switch, but the displaced intent is pushed on the return
 * stack (top last). With nothing in focus it is an ordinary switch. */
export function interruptEffects(ctx: SwitchContext, target: string): Effect[] {
  const displaced = ctx.pointer.focused;
  if (!displaced) return switchEffects(ctx, target);
  return pointerEffects(ctx, { focused: target, since: ctx.now ?? nowIso(), returnStack: [...ctx.pointer.returnStack, displaced] });
}

/** `back`: resume the top of the return stack and pop it; null when the stack is empty. */
export function backEffects(ctx: SwitchContext): Effect[] | null {
  const target = returnTarget(ctx.pointer);
  if (!target) return null;
  return pointerEffects(ctx, { focused: target, since: ctx.now ?? nowIso(), returnStack: ctx.pointer.returnStack.slice(0, -1) });
}

/** `stop`: nothing in focus (the return stack is kept — `back` still works after a stop). */
export function stopEffects(ctx: SwitchContext): Effect[] {
  return pointerEffects(ctx, { focused: null, since: ctx.now ?? nowIso() });
}

export interface NewIntent {
  /** The intent's document path (`/attn/intents/YYYY/MM/YYYY-MM-DD-<slug>.md`, unique — `intentPath`). */
  path: string;
  title: string;
  tags: string[];
  project?: string | null;
  /** The declaration text under the H1, when any. */
  body?: string;
}

/** The `create` of an intent document: the type, `layer: draft`, `status: active`, the title, `tags` when any, the title as the H1. */
export function createIntentEffect(intent: NewIntent): Effect {
  const frontmatter: Record<string, unknown> = { type: INTENT_TYPE, layer: "draft", status: "active", title: intent.title };
  if (intent.tags.length) frontmatter.tags = intent.tags;
  if (intent.project) frontmatter.project = intent.project;
  const body = intent.body?.trim();
  return { op: "create", path: intent.path, markdown: `# ${intent.title}\n${body ? `\n${body}\n` : ""}`, frontmatter };
}

/** Declare a new intent WITHOUT focusing it (Add Intent): its `create`, nothing else. */
export function declareEffects(intent: NewIntent): Effect[] {
  return [createIntentEffect(intent)];
}

/** Declare a new intent AND focus it, in one request: the `create`, then the pointer. */
export function declareAndFocusEffects(ctx: SwitchContext, intent: NewIntent, kind: "switch" | "interrupt" = "switch"): Effect[] {
  const focus = kind === "interrupt" ? interruptEffects(ctx, intent.path) : switchEffects(ctx, intent.path);
  return [createIntentEffect(intent), ...focus];
}

// ---- Plans and Receipts (after repo-explorer) ---------------------------------------------------

export interface Plan {
  planId: string;
  /** The effects AS GIVEN (the digest form of `execute` needs these). */
  effects: Effect[];
  summary: string[];
  diffs: Record<string, { before: string; after: string }>;
  revisions: { id: string; path: string; hash: string }[];
  wire: Wire;
}

export interface Receipt {
  planId: string;
  /** Null when the plan had nothing to commit. */
  commit: string | null;
  revisions: { id: string; path: string; hash: string }[];
  newIds: Record<string, string>;
  committed: boolean;
  summary: string[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const record = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strings = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).filter((s): s is string => typeof s === "string") : []);
const revisions = (v: unknown) => (Array.isArray(v) ? (v as Wire[]).map((r) => ({ id: str(r.id), path: str(r.path), hash: str(r.hash) })) : []);

export function planOf(wire: Wire, effects: Effect[]): Plan {
  const preview = record(wire.preview);
  const diffs: Plan["diffs"] = {};
  for (const [path, d] of Object.entries(record(preview.diffs))) {
    const r = record(d);
    diffs[path] = { before: str(r.before), after: str(r.after) };
  }
  return { planId: str(wire.plan_id), effects, summary: strings(preview.summary), diffs, revisions: revisions(preview.revisions), wire };
}

export function receiptOf(wire: Wire): Receipt {
  const newIds: Record<string, string> = {};
  for (const [k, v] of Object.entries(record(wire.new_ids))) if (typeof v === "string") newIds[k] = v;
  return {
    planId: str(wire.plan_id),
    commit: typeof wire.commit === "string" ? wire.commit : null,
    revisions: revisions(wire.revisions),
    newIds,
    committed: wire.committed === true,
    summary: strings(wire.summary),
  };
}

/** `apply { effects, reason }` — plan + commit in one call, one transaction. */
export async function applyEffects(caller: Caller, effects: Effect[], repo: string | null, reason: string): Promise<Receipt> {
  return receiptOf(await caller.call<Wire>("apply", { effects, reason, ...repoArg(repo) }));
}

/** `plan { effects, diffs: true }` — the preview (summary + before/after bodies). */
export async function planEffects(caller: Caller, effects: Effect[], repo: string | null): Promise<Plan> {
  return planOf(await caller.call<Wire>("plan", { effects, diffs: true, ...repoArg(repo) }), effects);
}

/** `execute { plan_id, effects }` — the digest form, with the effects the plan was made from. */
export async function executePlan(caller: Caller, plan: Plan, repo: string | null, reason?: string): Promise<Receipt> {
  return receiptOf(await caller.call<Wire>("execute", { plan_id: plan.planId, effects: plan.effects, ...(reason ? { reason } : {}), ...repoArg(repo) }));
}
