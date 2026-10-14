// Every mutation attn makes is ONE `apply { effects }` (or `plan` → `execute`)
// with several effects, so it is atomic: a focus switch is the pointer's
// `set frontmatter.focused` / `since` (/ `return_stack`) PLUS the `insert` of
// one list item at the end of today's stream document — `create`d first in the
// same request when the day has no document yet, the insert then addressing
// it as `$new.0` (spec/mutate §11.1: the first `create` of a request is `$new.0`;
// its blocks take the symbols after it, which is why the stream effects come
// FIRST in every list here). Declaring an intent and focusing it is one call
// too (create + the switch). CAS: the pointer's first `set` carries
// `expect.revision` = the pointer's `rev` as last read, so a switch made from
// another device between the read and this write is `stale_plan` (its `fix`
// is the same request re-pinned — the app shows it rather than taking it).
//
// The Receipt shapes and plan/execute helpers follow repo-explorer's lib/writes.ts.

import { repoArg, type Caller, type Wire } from "./mcp-client.ts";
import { POINTER_PATH, clockOf, dayOf, nowIso, streamPath, type CueTrigger, type TransitionKind } from "./model.ts";
import { returnTarget, type FocusState } from "./pointer.ts";

export type Effect = Record<string, unknown>;

/** What a switch needs to know: the pointer as last read, the clock, and which stream days already have a document. */
export interface SwitchContext {
  pointer: FocusState;
  /** The moment of the switch (ISO, UTC); defaults to the real clock. */
  now?: string;
  /** The `YYYY-MM-DD` days under `/attn/stream/` that exist (from `docs_tree`). */
  streamDays: ReadonlySet<string> | readonly string[];
}

const has = (days: SwitchContext["streamDays"], day: string): boolean => (days instanceof Set ? days.has(day) : (days as readonly string[]).includes(day));

/** One stream line: `- 09:30:12Z → /attn/intents/oqx.md (switch)`; a stop writes `none`. */
export function streamLine(now: string, target: string | null, kind: TransitionKind): string {
  return `- ${clockOf(now)} → ${target ?? "none"} (${kind})`;
}

/** The markdown a new stream day is created with (the line itself is a separate `insert`, so every line is an insert). */
export function streamDocMarkdown(day: string): string {
  return `# ${day}\n`;
}

/** The effects that append one transition to today's stream: an `insert` at the
 * document's end, preceded by its `create` when the day has no document yet
 * (then the insert addresses `$new.0`). ALWAYS first in a request. */
export function streamEffects(ctx: SwitchContext, target: string | null, kind: TransitionKind): Effect[] {
  const now = ctx.now ?? nowIso();
  const day = dayOf(now);
  const line = streamLine(now, target, kind);
  if (has(ctx.streamDays, day)) return [{ op: "insert", into: streamPath(now), at: "end", markdown: line }];
  return [
    { op: "create", path: streamPath(now), markdown: streamDocMarkdown(day), frontmatter: { type: "attn-stream", date: day } },
    { op: "insert", into: "$new.0", at: "end", markdown: line },
  ];
}

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
      markdown: "# Current focus\n\nThe focus pointer: `focused` is the intent in focus (or null), `since` when it took focus, `return_stack` the intents an `interrupt` displaced (top last). Rewritten by every switch; the history is in `stream/`.\n",
      frontmatter: { type: "attn-state", focused: patch.focused, since: patch.since, return_stack: patch.returnStack ?? [] },
    }];
  }
  const expect = p.rev ? { expect: { revision: p.rev } } : {};
  const out: Effect[] = [
    { op: "set", target: POINTER_PATH, field: "frontmatter.focused", value: patch.focused, ...expect },
    { op: "set", target: POINTER_PATH, field: "frontmatter.since", value: patch.since },
  ];
  if (patch.returnStack !== undefined) out.push({ op: "set", target: POINTER_PATH, field: "frontmatter.return_stack", value: patch.returnStack });
  return out;
}

/** An ordinary switch: the stream line, then the pointer (the return stack is untouched). */
export function switchEffects(ctx: SwitchContext, target: string): Effect[] {
  const now = ctx.now ?? nowIso();
  return [...streamEffects({ ...ctx, now }, target, "switch"), ...pointerEffects(ctx, { focused: target, since: now })];
}

/** `interrupt`: like a switch, but the displaced intent is pushed on the return
 * stack (top last). With nothing in focus it is an ordinary switch. */
export function interruptEffects(ctx: SwitchContext, target: string): Effect[] {
  const now = ctx.now ?? nowIso();
  const displaced = ctx.pointer.focused;
  if (!displaced) return switchEffects({ ...ctx, now }, target);
  return [
    ...streamEffects({ ...ctx, now }, target, "interrupt"),
    ...pointerEffects(ctx, { focused: target, since: now, returnStack: [...ctx.pointer.returnStack, displaced] }),
  ];
}

/** `back`: resume the top of the return stack and pop it; null when the stack is empty. */
export function backEffects(ctx: SwitchContext): Effect[] | null {
  const target = returnTarget(ctx.pointer);
  if (!target) return null;
  const now = ctx.now ?? nowIso();
  return [
    ...streamEffects({ ...ctx, now }, target, "back"),
    ...pointerEffects(ctx, { focused: target, since: now, returnStack: ctx.pointer.returnStack.slice(0, -1) }),
  ];
}

/** `stop`: nothing in focus (the return stack is kept — `back` still works after a stop). */
export function stopEffects(ctx: SwitchContext): Effect[] {
  const now = ctx.now ?? nowIso();
  return [...streamEffects({ ...ctx, now }, null, "stop"), ...pointerEffects(ctx, { focused: null, since: now })];
}

export interface NewIntent {
  /** The intent's document path (`/attn/intents/<slug>.md`, unique — `intentPath`). */
  path: string;
  title: string;
  tags: string[];
  project?: string | null;
}

/** The `create` of an intent document: `type: intent`, `status: active`, `tags` when any, the title as the H1. */
export function createIntentEffect(intent: NewIntent): Effect {
  const frontmatter: Record<string, unknown> = { type: "intent", status: "active" };
  if (intent.tags.length) frontmatter.tags = intent.tags;
  if (intent.project) frontmatter.project = intent.project;
  return { op: "create", path: intent.path, markdown: `# ${intent.title}\n`, frontmatter };
}

/** Declare a new intent AND focus it, in one request: the stream line first
 * (so a created stream day is `$new.0`), the intent's `create`, the pointer. */
export function declareEffects(ctx: SwitchContext, intent: NewIntent, kind: "switch" | "interrupt" = "switch"): Effect[] {
  const now = ctx.now ?? nowIso();
  const focus = kind === "interrupt" ? interruptEffects({ ...ctx, now }, intent.path) : switchEffects({ ...ctx, now }, intent.path);
  // Place the create after the stream effects and before the pointer's.
  const streamCount = streamEffects({ ...ctx, now }, intent.path, kind).length;
  return [...focus.slice(0, streamCount), createIntentEffect(intent), ...focus.slice(streamCount)];
}

export interface NewCue {
  path: string;
  title: string;
  /** The intent the cue belongs to (its path). */
  intent: string;
  trigger: CueTrigger;
  /** `trigger: focus` — an OQX predicate over the newly focused intent's row. */
  when?: string;
  /** `trigger: time` — an ISO timestamp. */
  at?: string;
  /** `trigger: query` — the OQX whose membership set is watched (goes in a ```oqx fence). */
  query?: string;
  /** The cue's text, shown when it fires. */
  text: string;
}

/** The `create` of a cue document. */
export function createCueEffect(cue: NewCue): Effect {
  const frontmatter: Record<string, unknown> = { type: "cue", intent: cue.intent, trigger: cue.trigger, status: "active" };
  if (cue.trigger === "focus" && cue.when !== undefined) frontmatter.when = cue.when;
  if (cue.trigger === "time" && cue.at !== undefined) frontmatter.at = cue.at;
  let markdown = `# ${cue.title}\n`;
  if (cue.trigger === "query" && cue.query !== undefined) markdown += `\n\`\`\`oqx\n${cue.query.trim()}\n\`\`\`\n`;
  if (cue.text.trim()) markdown += `\n${cue.text.trim()}\n`;
  return { op: "create", path: cue.path, markdown, frontmatter };
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
