// Frontmatter edits through the Effect layer (spec/mutate §11 4.0, spec/surface
// §4 5.0): `plan { effects: [{ op: "set", target: <path>, field:
// "_frontmatter.<k>", value }], diffs: true }` previews — the Plan's
// `preview.summary` (one line in words per effect) and `preview.diffs` (the
// whole before/after bytes per touched document) — and `execute { plan_id,
// effects }` commits exactly that plan (the digest form: the same effects
// re-planned, committed only when the digest still matches; a document that
// moved on is `plan_mismatch` / `stale_plan`, retriable: plan again). The
// Receipt `{ plan_id, commit, revisions: [{ _id, _path, _hash }], new_ids,
// committed, summary }` — a revision's keys are row attributes (`_`-prefixed),
// the rest roles. The field is `_frontmatter.<k>`: the frontmatter handle is
// engine-provided, the key under it the user's.

import { setFrontmatter, unsetFrontmatter, type Receipt as ClientReceipt, type RepositoryCommand } from "@omgbase/client";
import { repoArg, type Caller, type Wire } from "./mcp-client.ts";
import { rooted } from "./paths.ts";

export type Effect = Record<string, unknown>;

/** `set _frontmatter.<key> = value` on a document (a bare path is a document target, spec/mutate 3.2). */
export function setFrontmatterEffect(path: string, key: string, value: unknown): Effect {
  return { op: "set", target: rooted(path), field: `_frontmatter.${key}`, value };
}

/** `unset _frontmatter.<key>`. */
export function unsetFrontmatterEffect(path: string, key: string): Effect {
  return { op: "unset", target: rooted(path), field: `_frontmatter.${key}` };
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
  const revisions = Array.isArray(preview.revisions) ? (preview.revisions as Wire[]).map((r) => ({ id: str(r._id), path: rooted(str(r._path)), hash: str(r._hash) })) : [];
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
    revisions: Array.isArray(wire.revisions) ? (wire.revisions as Wire[]).map((r) => ({ id: str(r._id), path: rooted(str(r._path)), hash: str(r._hash) })) : [],
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

// ---- the plan as a command ------------------------------------------------------------------

/** What a committed frontmatter plan remembers for its undo. */
export interface FrontmatterPlanState {
  key: string;
  /** The value the plan wrote (`undefined`: the key was unset). */
  value: unknown;
  /** The key's value before the write (`undefined`: absent). */
  previous: unknown;
  existed: boolean;
}

/** A previewed frontmatter edit as a `CommandLog` entry: `apply` commits the
 * plan the user confirmed (the digest form of `execute`); `compensate` re-reads
 * the document and REFUSES unless the key still holds exactly what the plan
 * wrote (another edit since would be overwritten), else restores the previous
 * value — or unsets a key the plan created — pinned to the document's current
 * revision. The page supplies `previous`/`existed` from the document it showed. */
export function frontmatterPlanCommand(input: {
  plan: Plan;
  path: string;
  key: string;
  value: unknown;
  previous: unknown;
  existed: boolean;
  repo: string | null;
  reason?: string;
}): RepositoryCommand<FrontmatterPlanState> {
  const { plan, path, key, value, repo } = input;
  const unset = value === undefined;
  return {
    kind: "repository",
    label: `${unset ? "unset" : "set"} ${key} in ${path}`,
    async apply(ctx) {
      const receipt = await ctx.client.call<ClientReceipt>("execute", { plan_id: plan.planId, effects: plan.effects, ...(input.reason ? { reason: input.reason } : {}), ...repoArg(repo) });
      return { receipts: [receipt], revisions: receipt.revisions, state: { key, value, previous: input.previous, existed: input.existed } };
    },
    async compensate(ctx, applied) {
      const d = await ctx.client.docsRead({ _path: path }, { repo });
      const fm = d.properties.frontmatter ?? {};
      const has = Object.prototype.hasOwnProperty.call(fm, key);
      const same = unset ? !has : has && JSON.stringify(fm[key]) === JSON.stringify(value);
      if (!same) return { refused: `${key} in ${path} no longer holds what this edit wrote (now ${has ? JSON.stringify(fm[key]) : "absent"}) — not overwriting a later change` };
      const guard = d.rev ? { revision: d.rev } : undefined;
      const back = applied.state.existed ? setFrontmatter(path, key, applied.state.previous, guard) : unsetFrontmatter(path, key, guard);
      return { effects: [back], reason: `restore ${key}` };
    },
  };
}
