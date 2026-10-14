// Frontmatter edits through the Effect layer (spec/mutate §11, spec/surface
// §4): `plan { effects: [{ op: "set", target: <path>, field: "frontmatter.<k>",
// value }], diffs: true }` previews — the Plan's `preview.summary` (one line in
// words per effect) and `preview.diffs` (the whole before/after bytes per
// touched document) — and `execute { plan_id, effects }` commits exactly that
// plan (the digest form: the same effects re-planned, committed only when the
// digest still matches; a document that moved on is `plan_mismatch` /
// `stale_plan`, retriable: plan again). The Receipt `{ plan_id, commit,
// revisions: [{ id, path, hash }], new_ids, committed, summary }`.

import { repoArg, type Caller, type Wire } from "./mcp-client.ts";
import { rooted } from "./paths.ts";

export type Effect = Record<string, unknown>;

/** `set frontmatter.<key> = value` on a document (a bare path is a document target, spec/mutate 3.2). */
export function setFrontmatterEffect(path: string, key: string, value: unknown): Effect {
  return { op: "set", target: rooted(path), field: `frontmatter.${key}`, value };
}

/** `unset frontmatter.<key>`. */
export function unsetFrontmatterEffect(path: string, key: string): Effect {
  return { op: "unset", target: rooted(path), field: `frontmatter.${key}` };
}

/** The value a user typed, as YAML-ish scalars read: `true`/`false`/`null`, a
 * number, a JSON array/object/quoted string, else the text itself. */
export function parseValue(text: string): unknown {
  const t = text.trim();
  if (t === "") return "";
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^[[{"]/.test(t)) {
    try { return JSON.parse(t); } catch { /* not JSON: a string that happens to start so */ }
  }
  return t;
}

export interface Plan {
  planId: string;
  /** The effects AS GIVEN (the digest form of `execute` needs these, not the plan's expanded `effects`). */
  effects: Effect[];
  summary: string[];
  /** Rooted path → before/after bytes (present when the plan was asked with `diffs: true`). */
  diffs: Record<string, { before: string; after: string }>;
  /** The touched documents after the write, as the preview foresees them. */
  revisions: { id: string; path: string; hash: string }[];
  /** The whole Plan as returned (the plan form of `execute`). */
  wire: Wire;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const record = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function planOf(wire: Wire, effects: Effect[]): Plan {
  const preview = record(wire.preview);
  const diffs: Plan["diffs"] = {};
  for (const [path, d] of Object.entries(record(preview.diffs))) {
    const r = record(d);
    diffs[rooted(path)] = { before: str(r.before), after: str(r.after) };
  }
  const revisions = Array.isArray(preview.revisions) ? (preview.revisions as Wire[]).map((r) => ({ id: str(r.id), path: rooted(str(r.path)), hash: str(r.hash) })) : [];
  return {
    planId: str(wire.plan_id),
    effects,
    summary: Array.isArray(preview.summary) ? (preview.summary as unknown[]).filter((s): s is string => typeof s === "string") : [],
    diffs,
    revisions,
    wire,
  };
}

export interface Receipt {
  planId: string;
  /** Null when the plan had nothing to commit. */
  commit: string | null;
  revisions: { id: string; path: string; hash: string }[];
  committed: boolean;
  summary: string[];
}

export function receiptOf(wire: Wire): Receipt {
  return {
    planId: str(wire.plan_id),
    commit: typeof wire.commit === "string" ? wire.commit : null,
    revisions: Array.isArray(wire.revisions) ? (wire.revisions as Wire[]).map((r) => ({ id: str(r.id), path: rooted(str(r.path)), hash: str(r.hash) })) : [],
    committed: wire.committed === true,
    summary: Array.isArray(wire.summary) ? (wire.summary as unknown[]).filter((s): s is string => typeof s === "string") : [],
  };
}

/** `plan { effects, diffs: true }`. */
export async function planEffects(caller: Caller, effects: Effect[], repo: string | null): Promise<Plan> {
  return planOf(await caller.call<Wire>("plan", { effects, diffs: true, ...repoArg(repo) }), effects);
}

/** `execute { plan_id, effects }` — the digest form, with the effects the plan was made from. */
export async function executePlan(caller: Caller, plan: Plan, repo: string | null, reason?: string): Promise<Receipt> {
  return receiptOf(await caller.call<Wire>("execute", { plan_id: plan.planId, effects: plan.effects, ...(reason ? { reason } : {}), ...repoArg(repo) }));
}

/** Is the plan a no-op (nothing would change)? The preview names no revision. */
export function planIsNoop(plan: Plan): boolean {
  return plan.revisions.length === 0;
}
