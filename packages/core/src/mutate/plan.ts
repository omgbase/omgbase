import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";
import { observeMints, withIdMinter } from "../core/ids.js";
import { findDoc } from "../core/read/reader.js";
import { inboundLinksTo } from "../graph/inbound-links.js";
import { withWriterLock } from "../sync/writer-lock.js";
import { ChangesetPlanner, type ApplyRevision, type ChangesetPlan, type Op, type OpResult } from "./apply.js";
import { commitChangeset, readDocBase, type CommitHead, type Effect as InternalEffect } from "./commit.js";
import { resolveDocStore, type DocStore } from "./doc-store.js";
import { parseNewDoc } from "./docs.js";
import {
  ConflictTracker, SymbolTable, isNewSymbol, lowerEffect, symbolicMinter, effectInvalid,
  type CreateEntry, type Effect, type LoweringContext, type ResolvedEffect, type RetargetPreview,
} from "./effects.js";
import type { IdentityPreview } from "./opset.js";
import { compilePlain, compileSelection, selectionInvalid, type EffectOrigin, type Selection } from "./select.js";
import { MutationError } from "./tree.js";
import { canonicalJson, fixRequest, rootOfId, narrowedTo, type FixRequest } from "./canonical.js";

// The Plan (spec/mutate §11.4–§11.7, 2.3): the frozen, executable, digest-named
// result of lowering an ordered effect list. `plan` writes nothing; `execute`
// commits exactly a plan — its preconditions re-validated inside the
// transaction by `commit.ts` — and `apply({ effects })` is plan + execute under
// one writer lock and one transaction. New identities are symbolic (`$new.n`,
// minted at execute, mapped in the receipt); a plan's identity is the sha256 of
// the canonical JSON of its executable core. Since 3.1 (§11.8) a request may
// carry an OQX `select` whose hits, bound to the `effects` as templates, ARE
// the effects (`select.ts`); the frozen `selection` is the core's seventh member.

export const PLAN_VERSION = 1 as const;
/** The lowering + conflict rules version (§11.4; the `matcher_v` precedent). */
export const PLANNER_V = "p3" as const;

/** A kernel op as the plan spells it on the wire: the fixture spelling (`child_ids`). */
export type WireOp =
  | Exclude<Op, { op: "update" }>
  | { op: "update"; block: string; markdown?: string; attrs?: Record<string, unknown>; expect?: { content_hash?: string; parent_children_hash?: string }; trivia?: string; child_ids?: Record<string, string> };

/** The lowered form `execute` replays (§11.4): every key present, `[]` when empty. */
export interface PlanOpset {
  /** `create` → the composed file, its document symbol and the index of the first kernel op planned after it (3.0; a later `set frontmatter.<k>` on the symbol is a head below) */
  creates: CreateEntry[];
  /** `move document` → the row/file rename (its retarget updates are in `ops`) */
  moves: { id: string; from: string; to: string }[];
  /** `remove document` */
  tombstones: { id: string; path: string }[];
  /** per document, the file head — everything before the first block (frontmatter incl. fences and separator) */
  set_frontmatter: { doc: string; raw: string }[];
  /** the kernel ops, in order; new structure is referenced by kernel placeholders `$k.ids[j]` */
  ops: WireOp[];
}

export interface PlanPreconditions {
  /** the row triples (`spec/mutate` §4 step 5) of every document the plan touches, loaded ones first in load order */
  docs: { id: string; path: string; base_revision: string | null; hash: string | null }[];
  /** every block content hash the plan pins (caller-given or pinned from the live row), first-pin order */
  blocks: { id: string; content_hash: string }[];
  /** the caller's destination-parent CAS pins */
  parents: { doc: string; parent: string | null; parent_children_hash: string }[];
  /** paths that must have no live document and no file: `create` paths and move destinations */
  absent_paths: string[];
}

export interface PlanPreview {
  results: OpResult[];
  revisions: ApplyRevision[];
  diffs: Record<string, { before: string; after: string }>;
  /** (3.0) per `set content` document: the whole-document planner's identity consequences; present when a plan has one */
  identity?: Record<string, IdentityPreview>;
  /** (3.0) per `retarget` effect: its hits and pair counts; present when a plan has one */
  retarget?: RetargetPreview[];
  /** (3.3, §11.9) one line in words per resolved effect, in order — the plan as a worked example; `[]` for a zero-hit selection */
  summary: string[];
}

/** The executable core the digest covers. */
export interface PlanCore {
  version: typeof PLAN_VERSION;
  planner_v: string;
  effects: ResolvedEffect[];
  opset: PlanOpset;
  preconditions: PlanPreconditions;
  new_ids: { symbol: string; kind: "block" | "document" }[];
  /** (3.1, §11.8) the selector, its templates and the hits it bound — present only for a selector plan */
  selection?: Selection;
}

export interface Plan extends PlanCore {
  plan_id: string;
  diagnostics: string[];
  /** (3.2, §11.8 "Sugar") a plain request's effects AS WRITTEN when one carried a `-> ` / `{ oqx }` expression;
   *  not digested (the core already holds the concrete effects), recorded in the intent record as `templates` */
  templates?: unknown[];
  /** excluded from the digest; omittable on echo */
  preview?: PlanPreview;
}

export interface Receipt {
  plan_id: string;
  /** the one `commits` row (`null` when the plan had nothing to commit) */
  commit: string | null;
  revisions: ApplyRevision[];
  /** `$new.n` → the minted id */
  new_ids: Record<string, string>;
  committed: true;
  /** (3.3, §11.9) the plan's `preview.summary` — what was committed, in words (`[]` when the plan was handed back without its preview) */
  summary: string[];
}

// ---- canonical JSON and the digest (§11.5) ----------------------------------------------

export { canonicalJson } from "./canonical.js";

/** The executable core of a plan — the six digested keys (seven with `selection`), nothing else. */
export function planCore(p: PlanCore): PlanCore {
  return {
    version: p.version, planner_v: p.planner_v, effects: p.effects, opset: p.opset, preconditions: p.preconditions, new_ids: p.new_ids,
    ...(p.selection !== undefined ? { selection: p.selection } : {}),
  };
}

/** `plan_id = hex(sha256(canonical(core)))` (§11.5). */
export function planDigest(core: PlanCore): string {
  return sha256(canonicalJson(planCore(core))).toString("hex");
}

// ---- planning (§11.6) ---------------------------------------------------------------------

export interface PlanEffectsRequest {
  repoId: string;
  /** Working-tree root for the default doc store (the `path_taken` disk check; the move/remove previews). */
  rootPath?: string;
  docStore?: DocStore;
  omgbaseDir?: string;
  /** The effects as given (validated here: a shape error is `filter_invalid`); with `select`, the templates (§11.8). */
  effects: unknown;
  /** (3.1) an OQX selector: its hits × `effects` (templates) are the effects planned */
  select?: unknown;
  /** (3.1) `{ max }`: the bound on the selection (`selection_too_large` beyond it); the implicit ceiling without it */
  expect?: unknown;
}

/** The kernel op as the plan carries it (`childIds` → `child_ids`). */
export function wireOp(o: Op): WireOp {
  if (o.op === "update") {
    const { childIds, ...rest } = o;
    return { ...rest, ...(childIds !== undefined ? { child_ids: childIds } : {}) };
  }
  return o;
}

/** A plan's op back to the kernel's spelling. */
export function kernelOp(o: WireOp): Op {
  if (o.op === "update") {
    const { child_ids, ...rest } = o;
    return { ...rest, ...(child_ids !== undefined ? { childIds: child_ids } : {}) };
  }
  return o;
}

/**
 * Lower an ordered effect list into a frozen Plan (§11.6): under the symbolic
 * minter, resolve and lower each effect in order (conflicts by focus kind,
 * identical duplicates dropped with a diagnostic), render the touched documents,
 * freeze the preconditions, digest the core. Reads only; mints no real id.
 */
export function planEffects(store: Store, req: PlanEffectsRequest): Plan {
  // A selector request (§11.8): the templates compile into the concrete effects
  // — hits × templates — and the frozen `selection` joins the core; an empty
  // selection is an empty plan (the non-empty rule of §11.1 is the templates').
  let effects: Effect[];
  let selection: Selection | undefined;
  let templates: unknown[] | undefined;
  let origins: (EffectOrigin | undefined)[] = [];
  if (req.select !== undefined || req.expect !== undefined) {
    if (req.select === undefined) throw selectionInvalid("`expect` bounds a selection — pass `select` with it");
    const compiled = compileSelection(store, req.repoId, req.select, req.expect, req.effects);
    effects = compiled.effects;
    selection = compiled.selection;
    origins = compiled.origins;
  } else {
    // (3.2) the `-> ` sugar and expressions over each effect's own target row; without any, the shape check alone.
    const compiled = compilePlain(store, req.repoId, req.effects);
    effects = compiled.effects;
    templates = compiled.templates;
    origins = compiled.origins;
  }
  const docStore = resolveDocStore(req);
  const symbols = new SymbolTable();
  return withIdMinter(symbolicMinter(symbols), () => {
    const planner = new ChangesetPlanner(store, req.repoId, req.omgbaseDir);
    const ctx: LoweringContext = {
      store, repoId: req.repoId, docStore, planner, symbols,
      blockSymbols: new Map(), creates: [], identity: new Map(), retargets: [], moves: [], tombstones: [], heads: new Map(), ops: [],
      pins: new Map(), parents: [], absentPaths: [], docBases: new Map(),
      tracker: new ConflictTracker(canonicalJson), canonical: canonicalJson, resolved: [], summary: [],
    };
    effects.forEach((e, i) => {
      try {
        lowerEffect(ctx, i, e);
      } catch (err) {
        // Every failure names the effect it arose from (the kernel's own data — `op_index`, `block` — stays);
        // an expanded effect's names its template and the hit it was bound to as well (§11.8).
        if (err instanceof MutationError) {
          if (err.data.effect_index === undefined) err.data = { ...err.data, effect_index: i };
          const origin = origins[i];
          if (origin !== undefined && err.data.row === undefined) {
            err.data = { ...err.data, ...(origin.template_index !== undefined ? { template_index: origin.template_index } : {}), row: origin.row };
          }
          // (3.3) the corrected example, built from the request as given (§8 "fix").
          const fix = planningFix(err, i, req, origins, symbols);
          if (fix !== undefined && err.data.fix === undefined) err.data = { ...err.data, fix };
        }
        throw err;
      }
    });
    const changeset = planner.finish();

    const opset: PlanOpset = {
      creates: ctx.creates,
      moves: ctx.moves.map((m) => ({ id: m.id, from: m.from, to: m.to })),
      tombstones: ctx.tombstones.map((t) => ({ id: t.id, path: t.path })),
      set_frontmatter: [...ctx.heads].map(([doc, raw]) => ({ doc, raw })),
      ops: ctx.ops.map(wireOp),
    };
    const docs: PlanPreconditions["docs"] = changeset.preconditions.map((p) => ({ id: p.id, path: p.path, base_revision: p.currentRev, hash: p.fileHash }));
    for (const [id, base] of ctx.docBases) {
      if (!docs.some((d) => d.id === id)) docs.push({ id, path: base.path, base_revision: base.currentRev, hash: base.fileHash });
    }
    const preconditions: PlanPreconditions = {
      docs,
      blocks: [...ctx.pins].map(([id, content_hash]) => ({ id, content_hash })),
      parents: ctx.parents,
      absent_paths: ctx.absentPaths,
    };
    const core: PlanCore = { version: PLAN_VERSION, planner_v: PLANNER_V, effects: ctx.resolved, opset, preconditions, new_ids: symbols.entries, ...(selection !== undefined ? { selection } : {}) };
    const plan_id = planDigest(core);

    // The preview (not digested): the kernel results, every revision the commit
    // would record — a created document's under its symbol, from its adopted
    // tree like any loaded document's — and the per-file diffs: a create
    // `"" → bytes`, a move two entries (its retargeted bytes land at the new
    // path), a removal `bytes → ""`.
    const diffs: Record<string, { before: string; after: string }> = { ...changeset.diffs };
    const revisions: ApplyRevision[] = [...changeset.revisions];
    for (const m of ctx.moves) {
      const bytes = docStore.read(m.from) ?? "";
      const own = diffs[m.from];
      delete diffs[m.from];
      diffs[m.from] = { before: bytes, after: "" };
      diffs[m.to] = { before: "", after: own?.after ?? bytes };
    }
    for (const t of ctx.tombstones) diffs[t.path] = { before: docStore.read(t.path) ?? "", after: "" };
    for (const r of revisions) {
      const moved = ctx.moves.find((m) => m.id === r.id);
      if (moved) r.path = moved.to;
    }
    const preview: PlanPreview = { results: changeset.results, revisions, diffs, summary: ctx.summary };
    if (ctx.identity.size > 0) preview.identity = Object.fromEntries(ctx.identity);
    if (ctx.retargets.length > 0) preview.retarget = ctx.retargets;
    return { ...core, plan_id, diagnostics: ctx.tracker.diagnostics, ...(templates !== undefined ? { templates } : {}), preview };
  });
}

// ---- the corrected examples of planning errors (§8 "fix", 3.3) ------------------------------

/** The request as the caller gave it, for a `fix`: `select`/`expect` only when present. */
function requestOf(req: { effects: unknown; select?: unknown; expect?: unknown }): FixRequest {
  return { effects: req.effects, ...(req.select !== undefined ? { select: req.select } : {}), ...(req.expect !== undefined ? { expect: req.expect } : {}) };
}

/**
 * `conflicting_effects`: keep the later effect — the request minus the earlier
 * one; under a selector, a cross-hit collision narrows the selector to the
 * later hit (`from <root> where id == …`, `expect.max: 1`) and a same-hit
 * collision drops the earlier template. `stale_plan` at plan time (an
 * `expect.revision` that no longer holds): the same request with the current
 * revision in that guard. `target_missing { symbol }` for a `$new.n` no earlier
 * effect created: the next `create` of a plain request moved before the effect
 * that uses it, the symbol renamed to the one that create will allocate.
 */
function planningFix(err: MutationError, i: number, req: PlanEffectsRequest, origins: (EffectOrigin | undefined)[], symbols: SymbolTable): string | undefined {
  const effects = Array.isArray(req.effects) ? (req.effects as unknown[]) : null;
  if (effects === null) return undefined;
  const selector = req.select !== undefined;
  if (err.code === "conflicting_effects" && Array.isArray(err.data.effects)) {
    const [a, b] = err.data.effects as [number, number];
    if (!selector) return fixRequest({ effects: effects.filter((_, k) => k !== a) });
    const oa = origins[a];
    const ob = origins[b];
    if (oa === undefined || ob === undefined || oa.template_index === undefined) return undefined;
    if (oa.row.id !== ob.row.id) return fixRequest({ select: narrowedTo(rootOfId(ob.row.id), ob.row.id), effects, expect: { max: 1 } });
    return fixRequest({ ...requestOf(req), effects: effects.filter((_, k) => k !== oa.template_index) });
  }
  if (err.code === "stale_plan" && isRecord(err.data.current) && typeof err.data.current.revision === "string") {
    const t = selector ? origins[i]?.template_index : i;
    if (t === undefined || !isRecord(effects[t])) return undefined;
    const e = effects[t] as Record<string, unknown>;
    const expect = { ...(isRecord(e.expect) ? e.expect : {}), revision: err.data.current.revision };
    return fixRequest({ ...requestOf(req), effects: effects.map((x, k) => (k === t ? { ...e, expect } : x)) });
  }
  if (err.code === "target_missing" && typeof err.data.symbol === "string" && !selector && symbols.kindOf(err.data.symbol) === undefined) {
    const c = effects.findIndex((e, k) => k > i && isRecord(e) && e.op === "create");
    if (c < 0) return undefined;
    const symbol = `$new.${symbols.entries.length}`;
    const reordered = effects.filter((_, k) => k !== c);
    reordered.splice(i, 0, effects[c]);
    return fixRequest({ effects: reordered.map((e, k) => (k === i + 1 ? substituteSymbols(e, { [err.data.symbol as string]: symbol }) : e)) });
  }
  return undefined;
}

/** The `fix` of a plan that cannot be executed as it stands (`stale_plan`, `plan_mismatch`): re-plan and commit in one call — `apply` over the plan's selector form when it has one, else over its concrete effects (none when the plan has no effects: `apply` takes at least one). */
function replanFix(plan: Pick<Plan, "effects"> & { selection?: Selection }): string | undefined {
  if (plan.selection !== undefined) {
    const sel = plan.selection;
    return fixRequest({ select: sel.query, effects: sel.templates, expect: sel.expect ?? { max: sel.cardinality } });
  }
  return Array.isArray(plan.effects) && plan.effects.length > 0 ? fixRequest({ effects: plan.effects }) : undefined;
}

// ---- executing (§11.7) --------------------------------------------------------------------

export interface ExecuteRequest {
  repoId: string;
  rootPath?: string;
  docStore?: DocStore;
  omgbaseDir?: string;
  /** the commit's `actor` (null when the caller has none — a fixture step without one) and `reason` */
  origin: { actor: string | null; reason?: string };
  /** Commit timestamp (RFC 3339 UTC); defaults to now (see `ApplyRequest.ts`). */
  ts?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The plan form's admission (§11.7): `version` first — anything but 1 is
 * `unsupported_plan_version { version, supported: [1] }` — then the core's keys
 * must be present (`filter_invalid`), then the recomputed digest must equal the
 * embedded `plan_id` (`plan_mismatch { expected, actual }`). `preview` and
 * `diagnostics` are ignored.
 */
export function admitPlan(input: unknown): Plan {
  if (!isRecord(input)) throw effectInvalid("`plan` must be an object");
  if (input.version !== PLAN_VERSION) {
    throw new MutationError("unsupported_plan_version", `plan version ${JSON.stringify(input.version)} is not supported (supported: ${PLAN_VERSION})`, { version: input.version ?? null, supported: [PLAN_VERSION] });
  }
  for (const k of ["planner_v", "effects", "opset", "preconditions", "new_ids", "plan_id"]) {
    if (!(k in input)) throw effectInvalid(`\`plan.${k}\` is required`);
  }
  if (typeof input.planner_v !== "string") throw effectInvalid("`plan.planner_v` must be a string");
  if (!Array.isArray(input.effects)) throw effectInvalid("`plan.effects` must be an array");
  if (!isRecord(input.opset)) throw effectInvalid("`plan.opset` must be an object");
  for (const k of ["creates", "moves", "tombstones", "set_frontmatter", "ops"]) {
    if (!Array.isArray(input.opset[k])) throw effectInvalid(`\`plan.opset.${k}\` must be an array`);
  }
  for (const c of input.opset.creates as unknown[]) {
    if (!isRecord(c) || typeof c.symbol !== "string" || typeof c.path !== "string" || typeof c.source !== "string" || typeof c.before_op !== "number") {
      throw effectInvalid("`plan.opset.creates[]` entries are { symbol, path, source, before_op }");
    }
  }
  if (!isRecord(input.preconditions)) throw effectInvalid("`plan.preconditions` must be an object");
  for (const k of ["docs", "blocks", "parents", "absent_paths"]) {
    if (!Array.isArray(input.preconditions[k])) throw effectInvalid(`\`plan.preconditions.${k}\` must be an array`);
  }
  if (!Array.isArray(input.new_ids)) throw effectInvalid("`plan.new_ids` must be an array");
  if (input.selection !== undefined) {
    // (3.1) the optional seventh member: its shape, so the digest below covers what it says.
    const sel = input.selection;
    if (!isRecord(sel) || typeof sel.query !== "string" || !Array.isArray(sel.templates) || typeof sel.cardinality !== "number" || !Array.isArray(sel.identities)) {
      throw effectInvalid("`plan.selection` is { query, expect?, templates, cardinality, identities }");
    }
    if (sel.expect !== undefined && (!isRecord(sel.expect) || typeof sel.expect.max !== "number")) throw effectInvalid("`plan.selection.expect` is { max }");
  }
  if (typeof input.plan_id !== "string") throw effectInvalid("`plan.plan_id` must be a string");
  // (3.2) the written effects ride outside the digest, like `diagnostics`; their shape is all that is checked.
  if (input.templates !== undefined && !Array.isArray(input.templates)) throw effectInvalid("`plan.templates` must be an array");
  const plan = input as unknown as Plan;
  const actual = planDigest(plan);
  if (actual !== plan.plan_id) {
    throw new MutationError("plan_mismatch", "the plan's digest does not match its plan_id; it was edited or produced by a different planner — re-plan", { expected: plan.plan_id, actual, fix: replanFix(plan) });
  }
  return plan;
}

/** `execute { plan }` (§11.7): admit, then commit exactly that plan. */
export function executePlan(store: Store, req: ExecuteRequest & { plan: unknown }): Receipt {
  const plan = admitPlan(req.plan);
  const docStore = resolveDocStore(req);
  return underLock(req, () => executeAdmitted(store, req, plan, docStore));
}

/** The selector half of a request, threaded to the planner as given (absent keys stay absent). */
function selectorOf(req: { select?: unknown; expect?: unknown }): { select?: unknown; expect?: unknown } {
  return { ...(req.select !== undefined ? { select: req.select } : {}), ...(req.expect !== undefined ? { expect: req.expect } : {}) };
}

/** `execute { plan_id, effects, select?, expect? }` (§11.7): re-plan (with the selector when one is given, §11.8); the digest must equal `plan_id`, else `plan_mismatch`. */
export function executeByDigest(store: Store, req: ExecuteRequest & { planId: string; effects: unknown; select?: unknown; expect?: unknown }): Receipt {
  const docStore = resolveDocStore(req);
  return underLock(req, () => {
    const plan = planEffects(store, { repoId: req.repoId, docStore, ...(req.omgbaseDir !== undefined ? { omgbaseDir: req.omgbaseDir } : {}), effects: req.effects, ...selectorOf(req) });
    if (plan.plan_id !== req.planId) {
      throw new MutationError("plan_mismatch", "the effects or the documents they target changed since the plan was made; re-plan", { expected: req.planId, actual: plan.plan_id, fix: fixRequest(requestOf(req)) });
    }
    return executeAdmitted(store, req, plan, docStore);
  });
}

/**
 * `apply { effects }` with both halves kept (the sugar's seam — `sugar.ts`,
 * the `omg` verbs, the whole-document update): the Plan always, and the
 * Receipt when it committed (`dryRun` plans only — the CLI's `--dry-run`,
 * spec/cli §3.6). Plan + execute run under one lock and one transaction,
 * exactly as `applyEffects`.
 */
export function applyEffectsDetailed(store: Store, req: ExecuteRequest & { effects: unknown; select?: unknown; expect?: unknown; dryRun?: boolean }): { plan: Plan; receipt?: Receipt } {
  const docStore = resolveDocStore(req);
  const planIt = (): Plan => planEffects(store, { repoId: req.repoId, docStore, ...(req.omgbaseDir !== undefined ? { omgbaseDir: req.omgbaseDir } : {}), effects: req.effects, ...selectorOf(req) });
  if (req.dryRun) return { plan: planIt() };
  // One-shot `apply` with a selector must bound it (§11.8): the caller never saw
  // the hits. The fix (3.3) is the same call bounded at the selection's actual
  // size — the selector compiles (reads only) to count it; a selection the
  // compile itself refuses reports its own error and fix.
  if (req.select !== undefined && req.expect === undefined) {
    const { selection } = compileSelection(store, req.repoId, req.select, undefined, req.effects);
    throw selectionInvalid("`expect.max` is required on `apply` with `select` — bound the selection, or preview it with `plan`", { fix: fixRequest({ select: req.select, effects: req.effects, expect: { max: selection.cardinality } }) });
  }
  return underLock(req, () => {
    const plan = planIt();
    return { plan, receipt: executeAdmitted(store, req, plan, docStore) };
  });
}

/** `apply { effects, select?, expect? }` (§11.7): plan + execute under one lock and one transaction; `dryRun` returns the Plan. */
export function applyEffects(store: Store, req: ExecuteRequest & { effects: unknown; select?: unknown; expect?: unknown; dryRun?: boolean }): Plan | Receipt {
  const { plan, receipt } = applyEffectsDetailed(store, req);
  return receipt ?? plan;
}

// ---- symbols on the wire ----------------------------------------------------------------

/** Every string that is a key of `ids` replaced by its value, recursively (arrays and plain objects) — a plan's `$new.n` realized from a receipt's `new_ids`. */
export function substituteSymbols<T>(value: T, ids: Record<string, string>): T {
  if (typeof value === "string") return (Object.hasOwn(ids, value) ? ids[value]! : value) as T;
  if (Array.isArray(value)) return value.map((x) => substituteSymbols(x, ids)) as T;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = substituteSymbols(v, ids);
    return out as T;
  }
  return value;
}

/**
 * A planner error as the sugar reports it (`sugar.ts` `applySugar`): the
 * `effect_index` the planner adds (§11.6) is dropped — the tool or verb built
 * the effects itself, so the index names nothing the caller sent and the
 * kernel's data (`op_index`, `block`, `current`, …) stays as pinned.
 */
export function stripEffectIndex(err: unknown): unknown {
  if (err instanceof MutationError && Object.hasOwn(err.data, "effect_index")) {
    const { effect_index: _dropped, ...rest } = err.data;
    err.data = rest;
  }
  return err;
}

function underLock<T>(req: { omgbaseDir?: string }, fn: () => T): T {
  return req.omgbaseDir ? withWriterLock(req.omgbaseDir, fn) : fn();
}

/**
 * Commit an admitted plan: the preconditions pre-checked (`stale_plan` /
 * `doc_missing` / `path_taken`, outside the transaction, so a stale plan fails
 * before any id is minted), the opset replayed under the production minter
 * (`b` ids minted here, before the transaction — as every request's are; a
 * created document is re-adopted from its bytes at its `before_op` position,
 * so the replay mints in the plan's order and the i-th `b` IS the i-th block
 * symbol — the alias the `$new.k` in the ops resolve through), the internal
 * effects built in order — moves, the rendered documents (created ones as
 * `ingest_known { base: null }`; a moved document's revision lands at its new
 * path), tombstones — and `commitChangeset` re-validates every triple inside
 * `BEGIN IMMEDIATE`. The commit row's `ops` is the intent record
 * `canonical({ v: 1, plan_id, effects, selection?, templates? })` (§11.8: the
 * selector, its templates and the hits it bound ride along when the plan had
 * one; a plain request's written effects when one carried an expression, 3.2).
 */
function executeAdmitted(store: Store, req: ExecuteRequest, plan: Plan, docStore: DocStore): Receipt {
  for (const d of plan.preconditions.docs) {
    const row = readDocBase(store.db, d.id);
    if (!row) throw new MutationError("doc_missing", `doc ${d.id} no longer exists`, { doc: d.id });
    if (row.path !== d.path || row.currentRev !== d.base_revision || row.fileHash !== d.hash) {
      throw new MutationError("stale_plan", `document ${d.id} changed since the plan was made; re-plan`, {
        doc: d.id,
        expected_revision: d.base_revision,
        current: { revision: row.currentRev, hash: row.fileHash },
        retriable: true,
        fix: replanFix(plan),
      });
    }
  }
  for (const path of plan.preconditions.absent_paths) {
    if (findDoc(store, { repoId: req.repoId, path })) throw new MutationError("path_taken", `document already exists at ${path}`, { path });
    if (docStore.exists(path)) throw new MutationError("path_taken", `file already exists on disk at ${path}`, { path });
  }

  const minted: { b: string[]; d: string[] } = { b: [], d: [] };
  const ts = req.ts ?? new Date().toISOString();
  const head: CommitHead = {
    origin: "api",
    actor: req.origin.actor,
    reason: req.origin.reason ?? null,
    ops: canonicalJson({
      v: 1, plan_id: plan.plan_id, effects: plan.effects,
      ...(plan.selection !== undefined ? { selection: plan.selection } : {}),
      ...(plan.templates !== undefined ? { templates: plan.templates } : {}),
    }),
  };
  const stat = req.omgbaseDir !== undefined;
  const moved = new Map(plan.opset.moves.map((m) => [m.id, m]));
  const blockSymbols = plan.new_ids.filter((s) => s.kind === "block").map((s) => s.symbol);
  const planner = new ChangesetPlanner(store, req.repoId, req.omgbaseDir);

  const { effects, outcome } = observeMints(
    (prefix, id) => {
      if (prefix === "b") {
        // The i-th `b` the replay mints is the i-th block symbol (§11.7): alias it
        // so an op naming a created document's block by its symbol resolves.
        const symbol = blockSymbols[minted.b.length];
        minted.b.push(id);
        if (symbol !== undefined) planner.alias(symbol, id);
      } else if (prefix === "d") minted.d.push(id);
    },
    () => {
      const heads = plan.opset.set_frontmatter;
      for (const h of heads) if (!isNewSymbol(h.doc)) planner.setHead(h.doc, h.raw);
      // Re-adopt each created document where the plan did (`before_op`), its
      // head applied once its tree is loaded; the ops between in order.
      const creates = plan.opset.creates;
      let ci = 0;
      const adoptUpTo = (opIndex: number): void => {
        while (ci < creates.length && creates[ci]!.before_op <= opIndex) {
          const c = creates[ci++]!;
          planner.adoptNew(c.symbol, parseNewDoc(c.symbol, c.path, c.source));
          for (const h of heads) if (h.doc === c.symbol) planner.setHead(c.symbol, h.raw);
        }
      };
      plan.opset.ops.forEach((op, i) => {
        adoptUpTo(i);
        planner.push(kernelOp(op));
      });
      adoptUpTo(plan.opset.ops.length);
      const changeset: ChangesetPlan = planner.finish();

      const effects: InternalEffect[] = [];
      for (const m of plan.opset.moves) {
        const bytes = docStore.read(m.from) ?? "";
        const rev = readDocBase(store.db, m.id)?.currentRev ?? null;
        effects.push({ kind: "move_path", docId: m.id, from: m.from, to: m.to, currentRev: rev, inbound: inboundLinksTo(store, req.repoId, m.id, m.from), bytes });
        if (stat) effects.push({ kind: "clear_stat", path: m.from }, { kind: "record_stat", path: m.to, bytes });
      }
      for (const e of changeset.effects) {
        // The moved document is loaded under its OLD path (the row changes
        // inside the transaction); its rewritten bytes belong at the new path.
        if (e.kind === "ingest_known" && moved.has(e.docId)) effects.push({ ...e, path: moved.get(e.docId)!.to });
        else if (e.kind === "record_stat") {
          const m = plan.opset.moves.find((x) => x.from === e.path);
          effects.push(m ? { ...e, path: m.to } : e);
        } else effects.push(e);
      }
      for (const t of plan.opset.tombstones) {
        const rev = readDocBase(store.db, t.id)?.currentRev ?? null;
        effects.push({ kind: "tombstone", docId: t.id, path: t.path, currentRev: rev, pool: false });
        if (stat) effects.push({ kind: "clear_stat", path: t.path });
      }
      const outcome = commitChangeset(store, req.repoId, head, effects, ts, { docStore, ...(req.omgbaseDir !== undefined ? { omgbaseDir: req.omgbaseDir } : {}) });
      return { effects, outcome };
    },
  );

  // The receipt's revisions, in effect order; the ingest results pair with the
  // ingest effects in order (a created document's id is the one its ingest minted).
  const revisions: ApplyRevision[] = [];
  let j = 0;
  for (const e of effects) {
    if (e.kind === "ingest_reconciled") revisions.push({ id: outcome.ingests[j++]!.docId, path: e.path, hash: sha256(e.source).toString("hex") });
    else if (e.kind === "ingest_known") revisions.push({ id: outcome.ingests[j++]!.docId, path: e.path, hash: sha256(e.rendered).toString("hex") });
  }
  // `$new.n` → minted id: the i-th block symbol is the i-th `b` the replay
  // minted (all before the transaction, in the plan's order — the aliases
  // above), the i-th document symbol the i-th `d` the created documents'
  // ingests minted inside it (load order = effect order).
  const newIds: Record<string, string> = {};
  let bi = 0;
  let di = 0;
  for (const s of plan.new_ids) {
    const id = s.kind === "block" ? minted.b[bi++] : minted.d[di++];
    if (id !== undefined) newIds[s.symbol] = id;
  }
  return { plan_id: plan.plan_id, commit: outcome.commitId, revisions, new_ids: newIds, committed: true, summary: plan.preview?.summary ?? [] };
}
