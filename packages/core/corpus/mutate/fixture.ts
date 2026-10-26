// Fixture bridge for spec/mutate (README §9). Pure pieces, no vitest:
//
//   runCase()               §9: run a mutation script — the spec/store §9.4 observation-script
//                           shape plus the `apply` / `macro` / `docs` / `plan` / `disk` /
//                           `materialize` steps, the effect layer's `plan_effects` / `execute` /
//                           `apply_effects` / `canonical` steps (§11, 2.3; `select` + `expect` on the three
//                           effect steps since 3.1, §11.8) and the `crash_after_commit` modifier —
//                           through the production write paths against a fresh `:memory:` store
//                           and an in-memory doc store, check the invariants after every step,
//                           project `files` + the store tables
//   MemoryDocStore          the in-memory `DocStore` (path → bytes) the runner seeds from
//                           `observe` steps so file-CAS and the written bytes are checkable;
//                           `crashNext` makes its next file operation die (the process crashed
//                           after COMMIT, before the file half — spec/store §5.7)
//   toSpecOp()/toKernelOp() the fixture's op spelling (`child_ids`) ⇄ the reference's (`childIds`)
//   errorOutcome()          a MutationError → the pinned `{ code, op_index?, block?, current?, retriable? }`
//   validateFixtureFile()   the shape check a runner applies before trusting a file
//
// Nothing here decides anything about mutation; it drives the same code paths
// production uses (`apply`, the macros, the effect builders of `sugar.ts` for
// the `docs` step — the same builders the MCP server and the `omg` verbs call
// (3.0) —, `planUpdate` + the `set content` effect, `observeBatch`) with the
// fixture minter installed and a pinned commit clock, and re-expresses the
// results so two engines can be compared.
import { Store } from "../../src/core/store/store.js";
import { ensureRepo } from "../../src/core/attach.js";
import { sequentialMinter, withIdMinter } from "../../src/core/ids.js";
import { sha256 } from "../../src/core/hash.js";
import { reconstructContent } from "../../src/core/read/document.js";
import { sweepResurrectionPool } from "../../src/core/store/gc.js";
import { observeBatch } from "../../src/sync/observe.js";
import { apply, type ApplyResult, type Op } from "../../src/mutate/apply.js";
import type { DocStore } from "../../src/mutate/doc-store.js";
import type { At, Expect, To } from "../../src/mutate/ops.js";
import { MutationError } from "../../src/mutate/tree.js";
import {
  docsAppend, linksRepair, linksRetarget, listsInsertItem, nodeSet, sectionsAppend, sectionsMove, sectionsRename, tasksComplete,
  type LinkRepairPlan,
} from "../../src/mutate/macros.js";
import { findDocByRef } from "../../src/core/read/reader.js";
import { applySugar, createEffects, createdDoc, deleteDocEffects, moveDocEffects, moveLinks, setMetaEffects, type SugarDoc } from "../../src/mutate/sugar.js";
import { listPending, materializePending } from "../../src/mutate/materialize.js";
import { planUpdate } from "../../src/mutate/plan-update.js";
import type { Opset } from "../../src/mutate/opset.js";
import { applyEffects, canonicalJson, executeByDigest, executePlan, planEffects, type Plan, type Receipt } from "../../src/mutate/plan.js";
import { toReconcileConfig, deepEqualTol, type FixtureConfig } from "../reconcile/fixture.js";
import {
  FIXTURE_REPO_SLUG, TS_RE, checkInvariants, isHistoryStep, projectStore, runExecStep, runGcStep, toOutcome, validateSteps,
  type ExtraStepValidator, type JsonRow, type Row, type Step as StoreStep, type StepOutcome as StoreStepOutcome,
} from "../store/fixture.js";

export { deepEqualTol, FIXTURE_REPO_SLUG };

// ---- fixture shapes ------------------------------------------------------------

/** The six ops as the fixture spells them (README §2/§4): the reference's `childIds` is `child_ids` here. */
export type SpecOp =
  | { op: "insert"; doc?: string; to: To; markdown: string; expect?: Expect }
  | { op: "update"; block: string; markdown?: string; attrs?: Record<string, unknown>; expect?: Expect; trivia?: string; child_ids?: Record<string, string> }
  | { op: "move"; blocks: string[]; to: To; doc?: string; expect?: Expect }
  | { op: "remove"; blocks: string[]; expect?: Record<string, Expect> }
  | { op: "split"; block: string; at: number[]; expect?: Expect }
  | { op: "merge"; blocks: string[]; separator?: string; expect?: Record<string, Expect> };

export interface Origin {
  actor: string;
  reason?: string;
}

/** README §9 (2.2): a committing step with `crash_after_commit: true` dies after its transaction
 *  committed and before any file is written — the pending rows stay, the files are as they were,
 *  and the step's outcome is `{ crashed_after_commit: true }` (the caller never saw a result). */
export interface Crashable {
  crash_after_commit?: boolean;
}

export interface ApplyStep extends Crashable {
  /** commit timestamp (spec/store §2.4) — every commit this step records carries it */
  ts: string;
  ops: SpecOp[];
  origin: Origin;
  dry_run?: boolean;
}

export const MACROS = [
  "tasks_complete", "sections_append", "docs_append", "sections_rename", "sections_move", "lists_insert_item", "node_set", "links_repair", "links_retarget",
] as const;
export type MacroName = (typeof MACROS)[number];

export interface MacroStep extends Crashable {
  ts: string;
  name: MacroName;
  args: Record<string, unknown>;
  origin: Origin;
}

export const DOC_OPS = ["create", "move", "delete", "set_meta"] as const;
export type DocOpName = (typeof DOC_OPS)[number];

export interface DocsStep extends Crashable {
  ts: string;
  /** the `api` commit's actor (null when omitted) */
  actor?: string;
  create?: { path: string; markdown: string; frontmatter?: Record<string, unknown> };
  move?: { doc: string; to_path: string; retarget_inbound?: boolean };
  delete?: { doc: string };
  set_meta?: { doc: string; set?: Record<string, unknown>; unset?: string[] };
}

export interface PlanStep {
  ts: string;
  doc: string;
  content: string;
  /** also commit the same content as `apply_effects [set content]` (README §7, 3.0) → `{ receipt }` or the error */
  apply?: boolean;
  /** the origin that commit runs under; defaults to `{ actor: "agent:update" }` */
  origin?: Origin;
  /**
   * Steps run between planning and applying (only `observe` / `disk`) — the way
   * a fixture stages a stale plan; their outcomes are recorded under
   * `before_apply` in the step outcome.
   */
  before_apply?: Step[];
}

export interface DiskStep {
  path: string;
  source: string;
}

/** README §9 (2.3): `plan { effects }` → the Plan minus `preview`, or the error. (3.1, §11.8) `select` makes the
 *  effects templates bound to the selector's hits; `expect: { max }` bounds the selection. */
export interface PlanEffectsStep {
  effects: unknown[];
  select?: string;
  expect?: { max: number };
}

/** README §9 (2.3): `execute` in the plan form (`plan_step` names an earlier `plan_effects` /
 *  dry-run `apply_effects` step whose plan is executed; `plan` is an authored plan object) or the
 *  digest form (`plan_id` + `effects`) → the Receipt, or the error. */
export interface ExecuteStep extends Crashable {
  ts: string;
  plan_step?: number;
  plan?: Record<string, unknown>;
  plan_id?: string;
  effects?: unknown[];
  /** (3.1) the digest form's selector, re-run and re-digested (§11.8) */
  select?: string;
  expect?: { max: number };
  origin: Origin;
}

/** README §9 (2.3): `apply { effects }` → the Plan minus `preview` (`dry_run`) or the Receipt, or the error.
 *  (3.1) with `select`, `expect.max` is required unless `dry_run` (§11.8). */
export interface ApplyEffectsStep extends Crashable {
  ts: string;
  effects: unknown[];
  select?: string;
  expect?: { max: number };
  origin: Origin;
  dry_run?: boolean;
}

/** README §9 (2.3): the canonical JSON of `value` and its sha256 — the digest vectors (§11.5). */
export interface CanonicalStep {
  value: unknown;
}

export type Step =
  | StoreStep
  | { apply: ApplyStep }
  | { macro: MacroStep }
  | { docs: DocsStep }
  | { plan: PlanStep }
  | { plan_effects: PlanEffectsStep }
  | { execute: ExecuteStep }
  | { apply_effects: ApplyEffectsStep }
  | { canonical: CanonicalStep }
  | { disk: DiskStep }
  /** README §9 (2.2): replay every pending materialization row through the doc store → `{ materialized: [path…] }` */
  | { materialize: Record<string, never> };

/** The outcome of a committing step that `crash_after_commit` cut short. */
export interface CrashOutcome {
  crashed_after_commit: true;
}

/** `{ code, op_index?, block?, current?, retriable? }` — README §8's pinned data fields — plus the
 *  effect layer's (2.3): `effect_index`, `effects`, `focus`, `symbol`, `version`, `supported`, `expected`, `actual`,
 *  the selector's (3.1, §11.8): `template_index`, `row`, `expression`, `count`, `cardinality`, `max`, `implicit`,
 *  and (3.3) `fix` — the corrected example, a literal call both engines compose byte for byte. */
export interface ErrorOutcome {
  error: {
    code: string; op_index?: number; block?: string; current?: Record<string, unknown>; retriable?: boolean;
    effect_index?: number; effects?: number[]; focus?: Record<string, unknown>; symbol?: string;
    version?: unknown; supported?: unknown[]; expected?: string; actual?: string;
    template_index?: number; row?: Record<string, unknown>; expression?: string; count?: number;
    cardinality?: string | number; max?: number; implicit?: boolean;
    fix?: string;
  };
}

export interface ApplyOutcome {
  results: { ids: string[]; removed?: string[]; merged_into?: string[] }[];
  revisions: { _id: string; _path: string; _hash: string }[];
  diffs?: Record<string, { before: string; after: string }>;
  committed: boolean;
}

export type StepOutcome = StoreStepOutcome | ApplyOutcome | ErrorOutcome | CrashOutcome | Record<string, unknown>;

export interface Projection {
  steps: StepOutcome[];
  /** the in-memory doc store after the last step, path → bytes, sorted by path */
  files: Record<string, string>;
  docs: Row[];
  blocks: JsonRow[];
  commits: Row[];
  /** spec/store §9.4 (17.0, 3d): the change feed an api commit writes — one row (`plan_id` for an effect-driven request) and one entry per touched document (`moved` with `from_path`, `deleted`). */
  feed: Row[];
  feed_entries: Row[];
  revisions: Row[];
  dispositions: JsonRow[];
  resurrection_pool: Row[];
  /** spec/store §9.4 (14.0): the rows a crashed or refused file half left behind */
  pending_materializations: Row[];
}

/** The projected tables, in the order the fixture emits them (README §9). */
export const PROJECTED_TABLES = ["docs", "blocks", "commits", "feed", "feed_entries", "revisions", "dispositions", "resurrection_pool", "pending_materializations"] as const;

export interface FixtureCase {
  name: string;
  notes?: string;
  /** optional spec/reconcile §6 overrides for every observe step and every plan */
  config?: FixtureConfig;
  steps: Step[];
  expect: Projection;
}

export interface FixtureFile {
  suite: string;
  cases: FixtureCase[];
}

export const CASE_KEYS = ["name", "notes", "config", "steps", "expect"] as const;

/** `current.markdown` longer than this many UTF-8 bytes is dropped from a recorded error (keeps fixtures readable). */
export const CURRENT_MARKDOWN_LIMIT = 200;

// ---- helpers ------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Run `body` with a fresh fixture minter installed (spec/store §2.2). */
function withFixtureMinter<T>(body: () => T): T {
  return withIdMinter(sequentialMinter(), body);
}

// ---- the in-memory doc store ------------------------------------------------------

/**
 * README §9: "an in-memory doc store (a path → bytes map that the runner also
 * seeds from `observe` steps, so file-CAS and the written bytes are checkable)".
 * The stat cache is a filesystem concern; both stat methods are no-ops.
 */
export class CrashedAfterCommit extends Error {
  constructor() {
    super("crash_after_commit: the process died before the file half");
  }
}

export class MemoryDocStore implements DocStore {
  readonly files = new Map<string, string>();
  /** When set, the next `write`/`rename`/`remove` throws `CrashedAfterCommit` instead of touching a file. */
  crashNext = false;
  private crash(): void {
    if (this.crashNext) throw new CrashedAfterCommit();
  }
  exists(path: string): boolean {
    return this.files.has(path);
  }
  read(path: string): string | null {
    return this.files.get(path) ?? null;
  }
  write(path: string, bytes: string): void {
    this.crash();
    this.files.set(path, bytes);
  }
  rename(from: string, to: string): void {
    this.crash();
    const bytes = this.files.get(from);
    if (bytes === undefined) throw new Error(`rename: no file at ${from}`);
    this.files.delete(from);
    this.files.set(to, bytes);
  }
  remove(path: string): void {
    this.crash();
    this.files.delete(path);
  }
  recordStat(): void {}
  clearStat(): void {}
  /** path → bytes, sorted by path (the `files` projection). */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of [...this.files.keys()].sort()) out[k] = this.files.get(k)!;
    return out;
  }
}

// ---- op spelling ------------------------------------------------------------------

/** Fixture op → the reference's `Op` (`child_ids` → `childIds`). */
export function toKernelOp(s: SpecOp): Op {
  if (s.op === "update") {
    const { child_ids, ...rest } = s;
    return { ...rest, ...(child_ids !== undefined ? { childIds: child_ids } : {}) };
  }
  return s;
}

/** The reference's `Op` → the fixture spelling (`childIds` → `child_ids`), key order kept. */
export function toSpecOp(o: Op): SpecOp {
  if (o.op === "update") {
    const { childIds, ...rest } = o;
    return { ...rest, ...(childIds !== undefined ? { child_ids: childIds } : {}) };
  }
  return o;
}

// ---- outcomes -----------------------------------------------------------------------

/** An `apply` result as the fixture records it (`mergedInto` → `merged_into`). */
export function applyOutcome(res: ApplyResult): ApplyOutcome {
  const results = res.results.map((r) => {
    const x = r as { ids: string[]; removed?: string[]; mergedInto?: string[] };
    const out: ApplyOutcome["results"][number] = { ids: x.ids };
    if (x.removed !== undefined) out.removed = x.removed;
    if (x.mergedInto !== undefined) out.merged_into = x.mergedInto;
    return out;
  });
  return { results, revisions: res.revisions, ...(res.diffs !== undefined ? { diffs: res.diffs } : {}), committed: res.committed };
}

/**
 * A `MutationError` → the recorded error (README §8: the code plus the pinned
 * data fields `op_index`, `block`, `current`, `retriable`, each only when
 * present; a `current.markdown` over CURRENT_MARKDOWN_LIMIT bytes is dropped).
 * Anything else is a runner bug and is rethrown.
 */
export function errorOutcome(e: unknown): ErrorOutcome {
  if (!(e instanceof MutationError)) throw e;
  const error: ErrorOutcome["error"] = { code: e.code };
  const d = e.data;
  if (typeof d.op_index === "number") error.op_index = d.op_index;
  if (typeof d.block === "string") error.block = d.block;
  if (isRecord(d.current)) {
    const current = { ...d.current };
    if (typeof current.markdown === "string" && Buffer.byteLength(current.markdown, "utf8") > CURRENT_MARKDOWN_LIMIT) delete current.markdown;
    error.current = current;
  }
  if (typeof d.retriable === "boolean") error.retriable = d.retriable;
  if (typeof d.effect_index === "number") error.effect_index = d.effect_index;
  if (Array.isArray(d.effects)) error.effects = d.effects as number[];
  if (isRecord(d.focus)) error.focus = d.focus;
  if (typeof d.symbol === "string") error.symbol = d.symbol;
  if ("version" in d) error.version = d.version;
  if (Array.isArray(d.supported)) error.supported = d.supported;
  if (typeof d.expected === "string") error.expected = d.expected;
  if (typeof d.actual === "string") error.actual = d.actual;
  if (typeof d.template_index === "number") error.template_index = d.template_index;
  if (isRecord(d.row)) error.row = d.row;
  if (typeof d.expression === "string") error.expression = d.expression;
  if (typeof d.count === "number") error.count = d.count;
  if (typeof d.cardinality === "string" || typeof d.cardinality === "number") error.cardinality = d.cardinality;
  if (typeof d.max === "number") error.max = d.max;
  if (typeof d.implicit === "boolean") error.implicit = d.implicit;
  if (typeof d.fix === "string") error.fix = d.fix;
  return { error };
}

/** A Plan as the fixture records it (README §11.4): everything but `preview`. */
export function planOutcome(plan: Plan): Record<string, unknown> {
  const { preview: _preview, ...rest } = plan;
  return rest;
}

/** An opset as the fixture records it (README §7): snake_case precondition/matcher, fixture-spelled ops. */
export function toSpecOpset(o: Opset): Record<string, unknown> {
  return {
    version: o.version,
    kind: o.kind,
    target: o.target,
    precondition: { _id: o.precondition._id, _path: o.precondition._path, base_revision: o.precondition.baseRevision, _hash: o.precondition._hash },
    matcher_v: o.matcherV,
    ops: o.ops.map((p) => ({
      op: toSpecOp(p.op),
      disposition: p.disposition,
      blocks: p.blocks,
      confidence: p.confidence,
      reason: p.reason,
      ...(p.detail !== undefined ? { detail: p.detail } : {}),
    })),
    ...(o.frontmatter !== undefined ? { frontmatter: o.frontmatter } : {}),
    summary: o.summary,
    converges: o.converges,
    diagnostics: o.diagnostics,
  };
}

// ---- running a case ---------------------------------------------------------------------

export type FixtureCaseInput = Omit<FixtureCase, "expect">;

export interface Evaluation {
  expect: Projection;
  /** invariant violations, prefixed with the step they were found after (empty = fine) */
  problems: string[];
}

interface Runner {
  store: Store;
  repoId: string;
  docStore: MemoryDocStore;
  /** paths a `disk` step rewrote that no commit has ingested yet (the store may lag them) */
  pendingDisk: Set<string>;
  config: ReturnType<typeof toReconcileConfig>;
  /** the full plan (preview included) each `plan_effects` / dry-run `apply_effects` step produced, by step index */
  plans: Map<number, Plan>;
}

/**
 * Run a case: fresh `:memory:` store, fixture minter, repo `rp_0`, an empty
 * in-memory doc store; then every step through the production paths. The
 * invariants (spec/store §8 + `files[path] == reconstruct(doc)`) are checked
 * after every step and at the end; the projection is taken after the last step.
 */
export function runCase(c: FixtureCaseInput): Evaluation {
  return withFixtureMinter(() => {
    const store = new Store({ path: ":memory:" });
    try {
      const r: Runner = { store, repoId: ensureRepo(store, FIXTURE_REPO_SLUG, null), docStore: new MemoryDocStore(), pendingDisk: new Set(), config: toReconcileConfig(c.config), plans: new Map() };
      const steps: StepOutcome[] = [];
      const problems: string[] = [];
      c.steps.forEach((step, i) => {
        steps.push(runStep(r, step, i));
        for (const p of checkAll(r)) problems.push(`after step ${i}: ${p}`);
      });
      for (const p of checkAll(r)) problems.push(`at end: ${p}`);
      const t = projectStore(store.db, r.repoId);
      return {
        expect: {
          steps, files: r.docStore.snapshot(),
          docs: t.docs, blocks: t.blocks, commits: t.commits, feed: t.feed, feed_entries: t.feed_entries, revisions: t.revisions, dispositions: t.dispositions, resurrection_pool: t.resurrection_pool,
          pending_materializations: t.pending_materializations,
        },
        problems,
      };
    } finally {
      store.close();
    }
  });
}

function runStep(r: Runner, step: Step, index = -1): StepOutcome {
  if ("observe" in step) {
    const items = step.observe.items.map((it) => ({ path: it.path, content: it.source }));
    const outcomes = observeBatch(r.store, r.repoId, items, step.observe.ts, { config: r.config });
    // Seed the doc store: an observation IS the file's current bytes.
    for (const it of step.observe.items) {
      if (it.source === null) r.docStore.remove(it.path);
      else r.docStore.write(it.path, it.source);
      r.pendingDisk.delete(it.path);
    }
    return outcomes.map(toOutcome);
  }
  if ("sweep" in step) return { swept: sweepResurrectionPool(r.store, step.sweep.ts) };
  if ("gc" in step) return runGcStep(r.store);
  if ("exec" in step) return runExecStep(r.store, step.exec.sql);
  if (isHistoryStep(step)) throw new Error("retention steps (spec/store §9.4, 15.0) are not run by the mutate runner");
  if ("disk" in step) {
    r.docStore.write(step.disk.path, step.disk.source);
    r.pendingDisk.add(step.disk.path);
    return {};
  }
  if ("materialize" in step) return { materialized: materializePending(r.store, r.repoId, r.docStore) };
  if ("apply" in step) return crashable(r, step.apply, () => runApply(r, step.apply));
  if ("macro" in step) return crashable(r, step.macro, () => runMacro(r, step.macro));
  if ("docs" in step) return crashable(r, step.docs, () => runDocs(r, step.docs));
  if ("plan_effects" in step) return runPlanEffects(r, step.plan_effects, index);
  if ("execute" in step) return crashable(r, step.execute, () => runExecute(r, step.execute));
  if ("apply_effects" in step) return crashable(r, step.apply_effects, () => runApplyEffects(r, step.apply_effects, index));
  if ("canonical" in step) {
    const json = canonicalJson(step.canonical.value);
    return { json, digest: sha256(json).toString("hex") };
  }
  if ("remint_epoch" in step) throw new Error("remint_epoch (spec/store §9.4) is run by the store runner only");
  return runPlan(r, step.plan);
}

// ---- the effect layer (README §9, 2.3) ----

/** The selector half of an effect step, as given (absent keys stay absent). */
function selectorOf(s: { select?: string; expect?: { max: number } }): { select?: string; expect?: { max: number } } {
  return { ...(s.select !== undefined ? { select: s.select } : {}), ...(s.expect !== undefined ? { expect: s.expect } : {}) };
}

function runPlanEffects(r: Runner, s: PlanEffectsStep, index: number): StepOutcome {
  try {
    const plan = planEffects(r.store, { repoId: r.repoId, docStore: r.docStore, effects: s.effects, ...selectorOf(s) });
    r.plans.set(index, plan);
    return { plan: planOutcome(plan) };
  } catch (e) {
    return errorOutcome(e);
  }
}

function receiptOutcome(receipt: Receipt): StepOutcome {
  return { receipt };
}

function runExecute(r: Runner, s: ExecuteStep): StepOutcome {
  const base = { repoId: r.repoId, docStore: r.docStore, origin: s.origin, ts: s.ts };
  try {
    if (s.plan_id !== undefined) return receiptOutcome(executeByDigest(r.store, { ...base, planId: s.plan_id, effects: s.effects, ...selectorOf(s) }));
    const plan = s.plan ?? r.plans.get(s.plan_step!);
    if (plan === undefined) throw new Error(`execute: step ${s.plan_step} produced no plan`);
    return receiptOutcome(executePlan(r.store, { ...base, plan }));
  } catch (e) {
    return errorOutcome(e);
  }
}

function runApplyEffects(r: Runner, s: ApplyEffectsStep, index: number): StepOutcome {
  try {
    const res = applyEffects(r.store, { repoId: r.repoId, docStore: r.docStore, effects: s.effects, ...selectorOf(s), origin: s.origin, ts: s.ts, ...(s.dry_run !== undefined ? { dryRun: s.dry_run } : {}) });
    if (s.dry_run) {
      r.plans.set(index, res as Plan);
      return { plan: planOutcome(res as Plan) };
    }
    return receiptOutcome(res as Receipt);
  } catch (e) {
    return errorOutcome(e);
  }
}

// `crash_after_commit`: the doc store's next file operation dies. The commit
// phase writes nothing before its transaction commits (spec/mutate §4 step 5,
// 2.2), so the crash lands exactly between COMMIT and the first materialized
// file; the outcome records the crash, never a result the caller could not have
// seen. A step that errored before committing (a stale CAS, a conflict) never
// reaches a file operation and records its error as usual.
function crashable(r: Runner, s: Crashable, run: () => StepOutcome): StepOutcome {
  if (!s.crash_after_commit) return run();
  r.docStore.crashNext = true;
  try {
    const outcome = run();
    // No file operation ran (an error outcome, or a request with no file half).
    return outcome;
  } catch (e) {
    if (e instanceof CrashedAfterCommit) return { crashed_after_commit: true };
    throw e;
  } finally {
    r.docStore.crashNext = false;
  }
}

function runApply(r: Runner, s: ApplyStep): ApplyOutcome | ErrorOutcome {
  try {
    return applyOutcome(apply(r.store, {
      repoId: r.repoId,
      docStore: r.docStore,
      ops: s.ops.map(toKernelOp),
      origin: s.origin,
      ...(s.dry_run !== undefined ? { dryRun: s.dry_run } : {}),
      ts: s.ts,
    }));
  } catch (e) {
    return errorOutcome(e);
  }
}

function runMacro(r: Runner, s: MacroStep): StepOutcome {
  const a = s.args;
  let ops: Op[];
  let extra: Record<string, unknown> = {};
  const linkPlan = (p: LinkRepairPlan): Op[] => {
    extra = { hits: p.hits.map((h) => ({ _id: h._id, _path: h._path, old_raw: h.oldRaw, new_raw: h.newRaw })), pairs: p.pairs };
    return p.ops;
  };
  try {
    switch (s.name) {
      case "tasks_complete": ops = tasksComplete(r.store, a.blocks as string[]); break;
      case "sections_append": ops = sectionsAppend(a.heading as string, a.markdown as string); break;
      case "docs_append": ops = docsAppend(a.doc as string, a.markdown as string); break;
      case "sections_rename": ops = sectionsRename(r.store, a.heading as string, a.title as string); break;
      case "sections_move": ops = sectionsMove(r.store, a.heading as string, a.to as To); break;
      case "lists_insert_item": ops = listsInsertItem(a.anchor as string, a.at as At, a.markdown as string); break;
      case "node_set": ops = nodeSet(r.store, a.node as string, a.prop as string, a.value as string); break;
      case "links_repair":
        ops = linkPlan(linksRepair(r.store, r.repoId, a.repairs as { from: string; to: string }[], typeof a.path_glob === "string" ? { pathGlob: a.path_glob } : {}));
        break;
      case "links_retarget":
        ops = linkPlan(linksRetarget(r.store, r.repoId, a.from as string, a.to as string, typeof a.path_glob === "string" ? { pathGlob: a.path_glob } : {}));
        break;
    }
  } catch (e) {
    return errorOutcome(e);
  }
  const outcome = runApply(r, { ts: s.ts, ops: ops.map(toSpecOp), origin: s.origin });
  return { ops: ops.map(toSpecOp), ...extra, ...outcome };
}

// README §9 (3.0): the `docs` step runs the effect builders — `create`, `move
// document`, `remove document`, `set`/`unset _frontmatter.<k>` — through the
// Effect layer under the §6 reasons, exactly as the MCP tools and the `omg`
// verbs do; the step resolves its `doc` ref itself (`doc_missing` when it names
// nothing) and records `{ doc, path, committed }` (+ `dangling`/`retargeted`
// for a move) or the error (the planner's `effect_index` dropped: the step built
// the effects).
function runDocs(r: Runner, s: DocsStep): StepOutcome {
  const request = { repoId: r.repoId, docStore: r.docStore, ts: s.ts, actor: s.actor ?? null };
  const docOf = (ref: string): SugarDoc => {
    const info = findDocByRef(r.store, r.repoId, ref);
    if (!info) throw new MutationError("doc_missing", `no document ${ref}`);
    return { _id: info.docId, _path: info.path };
  };
  try {
    if (s.create) {
      const built = createEffects(s.create.path, s.create.markdown, s.create.frontmatter);
      const { receipt } = applySugar(r.store, request, built);
      const res = createdDoc(receipt!, (built.effects[0] as { path: string }).path);
      return { doc: res._id, path: res._path, committed: res.committed };
    }
    if (s.move) {
      const doc = docOf(s.move.doc);
      const retarget = s.move.retarget_inbound !== false;
      const links = moveLinks(r.store, r.repoId, doc, s.move.to_path, retarget);
      const built = moveDocEffects(doc, s.move.to_path, retarget);
      applySugar(r.store, request, built);
      return { doc: doc._id, path: (built.effects[0] as { to: string }).to, committed: true, dangling: links.dangling, retargeted: links.retargeted };
    }
    if (s.delete) {
      const doc = docOf(s.delete.doc);
      applySugar(r.store, request, deleteDocEffects(doc));
      return { doc: doc._id, path: doc._path, committed: true };
    }
    const m = s.set_meta!;
    const doc = docOf(m.doc);
    applySugar(r.store, request, setMetaEffects(doc, m.set, m.unset));
    return { doc: doc._id, path: doc._path, committed: true };
  } catch (e) {
    return errorOutcome(e);
  }
}

function runPlan(r: Runner, s: PlanStep): StepOutcome {
  let opset: Opset;
  try {
    // rootPath is only the default write target; the planner never writes.
    opset = planUpdate(r.store, r.repoId, "", s.doc, s.content, { config: r.config });
  } catch (e) {
    return errorOutcome(e);
  }
  const out: Record<string, unknown> = { opset: toSpecOpset(opset) };
  if (s.before_apply) out.before_apply = s.before_apply.map((step) => runStep(r, step));
  if (s.apply) {
    // 3.0: the opset is the planner's internal result; committing the content is
    // the `set content` effect (README §11.3), whose receipt is recorded.
    try {
      const effects = [{ op: "set", target: { kind: "document", _id: opset.target._id }, field: "content", value: s.content }];
      out.apply = receiptOutcome(applyEffects(r.store, { repoId: r.repoId, docStore: r.docStore, effects, origin: s.origin ?? { actor: "agent:update" }, ts: s.ts }) as Receipt);
    } catch (e) {
      out.apply = errorOutcome(e);
    }
  }
  return out;
}

// ---- checks -------------------------------------------------------------------------------

/**
 * spec/store §8 I1–I8 plus README §9 "files[path] == reconstruct(doc)" for
 * every live document. A path a `disk` step rewrote is exempt from the file
 * comparison until a commit ingests those bytes (the store legitimately lags a
 * human edit), as is a path with a pending materialization row (the file
 * legitimately lags the store); I1 then runs against the store's own
 * reconstruction.
 */
function checkAll(r: Runner): string[] {
  const db = r.store.db;
  const live = db
    .prepare("SELECT doc_id, path, file_hash FROM docs WHERE repo_id = ? AND deleted_at IS NULL AND head IS NOT NULL ORDER BY path")
    .all(r.repoId) as { doc_id: string; path: string; file_hash: Buffer | null }[];
  const problems: string[] = [];
  const lastSource = new Map<string, string>();
  // A path the api path still owes a file (a pending row, spec/store §5.7) is
  // legitimately behind the database until a materializer runs: the store's own
  // reconstruction stands in for the file, as for a `disk` edit.
  const owed = new Set(listPending(db, r.repoId).map((p) => p.path));
  for (const d of live) {
    const bytes = r.docStore.read(d.path);
    if (bytes !== null && d.file_hash && sha256(bytes).equals(d.file_hash)) r.pendingDisk.delete(d.path);
    if (r.pendingDisk.has(d.path) || owed.has(d.path)) {
      lastSource.set(d.path, reconstructContent(db, d.doc_id) ?? "");
      continue;
    }
    if (bytes === null) {
      problems.push(`files: live doc ${d.doc_id} (${d.path}) has no file in the doc store`);
      continue;
    }
    lastSource.set(d.path, bytes);
    const reconstructed = reconstructContent(db, d.doc_id) ?? "";
    if (reconstructed !== bytes) problems.push(`files: ${d.path} != reconstruct(${d.doc_id})`);
  }
  problems.push(...checkInvariants(r.store, r.repoId, lastSource));
  return problems;
}

// ---- validation -------------------------------------------------------------------------

export interface ValidateOptions {
  /** false while regenerating: cases may not have an `expect` yet */
  requireExpect?: boolean;
}

const OP_NAMES = ["insert", "update", "move", "remove", "split", "merge"];

function requireTs(body: Record<string, unknown>, here: string, problems: string[]): void {
  if (typeof body.ts !== "string" || !TS_RE.test(body.ts)) problems.push(`${here}: \`ts\` must be RFC 3339 UTC with three fractional digits and Z (spec/store §2.4)`);
}

function requireOrigin(v: unknown, here: string, problems: string[]): void {
  if (!isRecord(v) || typeof v.actor !== "string" || (v.reason !== undefined && typeof v.reason !== "string") || Object.keys(v).some((k) => k !== "actor" && k !== "reason")) {
    problems.push(`${here}: \`origin\` is { actor, reason? }`);
  }
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[], here: string, problems: string[]): void {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length > 0) problems.push(`${here}: unknown keys ${extra.join(", ")}`);
}

function validateOps(ops: unknown, here: string, problems: string[]): void {
  if (!Array.isArray(ops)) {
    problems.push(`${here}: \`ops\` must be an array`);
    return;
  }
  ops.forEach((o, i) => {
    if (!isRecord(o) || typeof o.op !== "string" || !OP_NAMES.includes(o.op)) problems.push(`${here}.ops[${i}]: an op is an object whose \`op\` is one of ${OP_NAMES.join("/")}`);
  });
}

const validateDisk: ExtraStepValidator = (body, here, problems) => {
  if (!isRecord(body)) {
    problems.push(`${here}: not an object`);
    return;
  }
  onlyKeys(body, ["path", "source"], here, problems);
  if (typeof body.path !== "string" || body.path === "" || body.path.startsWith("/")) problems.push(`${here}: \`path\` must be repo-relative with no leading slash`);
  if (typeof body.source !== "string") problems.push(`${here}: \`source\` must be a string`);
};

export const EXTRA_STEPS: Record<string, ExtraStepValidator> = {
  apply: (body, here, problems) => {
    if (!isRecord(body)) {
      problems.push(`${here}: not an object`);
      return;
    }
    onlyKeys(body, ["ts", "ops", "origin", "dry_run", "crash_after_commit"], here, problems);
    requireTs(body, here, problems);
    validateOps(body.ops, here, problems);
    requireOrigin(body.origin, here, problems);
    crashFlag(body, here, problems);
    if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") problems.push(`${here}: \`dry_run\` must be a boolean`);
  },
  macro: (body, here, problems) => {
    if (!isRecord(body)) {
      problems.push(`${here}: not an object`);
      return;
    }
    onlyKeys(body, ["ts", "name", "args", "origin", "crash_after_commit"], here, problems);
    requireTs(body, here, problems);
    crashFlag(body, here, problems);
    if (typeof body.name !== "string" || !(MACROS as readonly string[]).includes(body.name)) problems.push(`${here}: \`name\` must be one of ${MACROS.join("/")}`);
    if (!isRecord(body.args)) problems.push(`${here}: \`args\` must be an object`);
    requireOrigin(body.origin, here, problems);
  },
  docs: (body, here, problems) => {
    if (!isRecord(body)) {
      problems.push(`${here}: not an object`);
      return;
    }
    onlyKeys(body, ["ts", "actor", "crash_after_commit", ...DOC_OPS], here, problems);
    requireTs(body, here, problems);
    crashFlag(body, here, problems);
    if (body.actor !== undefined && typeof body.actor !== "string") problems.push(`${here}: \`actor\` must be a string`);
    const ops = DOC_OPS.filter((k) => body[k] !== undefined);
    if (ops.length !== 1) problems.push(`${here}: exactly one of ${DOC_OPS.join("/")}`);
    else if (!isRecord(body[ops[0]!])) problems.push(`${here}.${ops[0]}: must be an object`);
  },
  plan: (body, here, problems) => {
    if (!isRecord(body)) {
      problems.push(`${here}: not an object`);
      return;
    }
    onlyKeys(body, ["ts", "doc", "content", "apply", "origin", "before_apply"], here, problems);
    requireTs(body, here, problems);
    if (typeof body.doc !== "string") problems.push(`${here}: \`doc\` must be a string`);
    if (typeof body.content !== "string") problems.push(`${here}: \`content\` must be a string`);
    if (body.apply !== undefined && typeof body.apply !== "boolean") problems.push(`${here}: \`apply\` must be a boolean`);
    if (body.origin !== undefined) requireOrigin(body.origin, here, problems);
    if (body.before_apply !== undefined) validateSteps(`${here}.before_apply`, body.before_apply, problems, { disk: validateDisk });
  },
  disk: validateDisk,
  materialize: (body, here, problems) => {
    if (!isRecord(body) || Object.keys(body).length > 0) problems.push(`${here}: \`materialize\` takes an empty object`);
  },
  plan_effects: (body, here, problems) => {
    if (!isRecord(body)) {
      problems.push(`${here}: not an object`);
      return;
    }
    onlyKeys(body, ["effects", "select", "expect"], here, problems);
    if (!Array.isArray(body.effects)) problems.push(`${here}: \`effects\` must be an array`);
    selectorShape(body, here, problems);
  },
  execute: (body, here, problems) => {
    if (!isRecord(body)) {
      problems.push(`${here}: not an object`);
      return;
    }
    onlyKeys(body, ["ts", "plan_step", "plan", "plan_id", "effects", "select", "expect", "origin", "crash_after_commit"], here, problems);
    requireTs(body, here, problems);
    requireOrigin(body.origin, here, problems);
    crashFlag(body, here, problems);
    selectorShape(body, here, problems);
    const planForm = body.plan_step !== undefined || body.plan !== undefined;
    const digestForm = body.plan_id !== undefined || body.effects !== undefined || body.select !== undefined || body.expect !== undefined;
    if (planForm === digestForm) problems.push(`${here}: exactly one of \`plan_step\` / \`plan\` (the plan form) or \`plan_id\` + \`effects\` (the digest form)`);
    if (body.plan_step !== undefined && body.plan !== undefined) problems.push(`${here}: \`plan_step\` and \`plan\` are alternatives`);
    if (body.plan_step !== undefined && typeof body.plan_step !== "number") problems.push(`${here}: \`plan_step\` must be a step index`);
    if (body.plan !== undefined && !isRecord(body.plan)) problems.push(`${here}: \`plan\` must be an object`);
    if (digestForm && (typeof body.plan_id !== "string" || !Array.isArray(body.effects))) problems.push(`${here}: the digest form needs \`plan_id\` (a string) and \`effects\` (an array)`);
  },
  apply_effects: (body, here, problems) => {
    if (!isRecord(body)) {
      problems.push(`${here}: not an object`);
      return;
    }
    onlyKeys(body, ["ts", "effects", "select", "expect", "origin", "dry_run", "crash_after_commit"], here, problems);
    requireTs(body, here, problems);
    if (!Array.isArray(body.effects)) problems.push(`${here}: \`effects\` must be an array`);
    selectorShape(body, here, problems);
    requireOrigin(body.origin, here, problems);
    crashFlag(body, here, problems);
    if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") problems.push(`${here}: \`dry_run\` must be a boolean`);
  },
  canonical: (body, here, problems) => {
    if (!isRecord(body) || !("value" in body) || Object.keys(body).length !== 1) problems.push(`${here}: \`canonical\` takes exactly \`value\``);
  },
};

/** README §9 (3.1): `select` is an OQX string, `expect` is `{ max: <non-negative integer> }`; `expect` needs `select`. */
function selectorShape(body: Record<string, unknown>, here: string, problems: string[]): void {
  if (body.select !== undefined && typeof body.select !== "string") problems.push(`${here}: \`select\` must be an OQX query string`);
  if (body.expect !== undefined) {
    if (!isRecord(body.expect) || typeof body.expect.max !== "number" || Object.keys(body.expect).some((k) => k !== "max")) problems.push(`${here}: \`expect\` is { max }`);
    if (body.select === undefined) problems.push(`${here}: \`expect\` needs \`select\``);
  }
}

function crashFlag(body: Record<string, unknown>, here: string, problems: string[]): void {
  if (body.crash_after_commit !== undefined && body.crash_after_commit !== true) problems.push(`${here}: \`crash_after_commit\` is \`true\` or absent`);
}

function validateConfig(at: string, config: unknown, problems: string[]): void {
  if (!isRecord(config)) problems.push(`${at}: \`config\` must be an object`);
}

function validateProjection(at: string, e: unknown, stepCount: number, problems: string[]): void {
  if (!isRecord(e)) {
    problems.push(`${at}: must be an object`);
    return;
  }
  const want = ["steps", "files", ...PROJECTED_TABLES];
  const keys = Object.keys(e).sort();
  const wantSorted = [...want].sort();
  if (keys.length !== wantSorted.length || keys.some((k, i) => k !== wantSorted[i])) {
    problems.push(`${at}: must have exactly the keys ${want.join(", ")} (got ${keys.join(", ")})`);
    return;
  }
  if (!isRecord(e.files)) problems.push(`${at}.files: must be an object`);
  for (const k of want) if (k !== "files" && !Array.isArray(e[k])) problems.push(`${at}.${k}: must be an array`);
  if (Array.isArray(e.steps) && stepCount >= 0 && e.steps.length !== stepCount) problems.push(`${at}.steps: ${e.steps.length} outcomes for ${stepCount} steps`);
}

/**
 * Validate a parsed `cases/<suite>.json`; returns the problems found (empty = valid).
 * `file` is the file name (with `.json`); the suite must equal its stem.
 */
export function validateFixtureFile(file: string, doc: unknown, opts: ValidateOptions = {}): string[] {
  const requireExpect = opts.requireExpect ?? true;
  const problems: string[] = [];
  if (!isRecord(doc)) return [`${file}: not an object`];
  const stem = file.replace(/\.json$/, "");
  if (doc.suite !== stem) problems.push(`${file}: \`suite\` must equal the file stem '${stem}' (got ${JSON.stringify(doc.suite)})`);
  const extra = Object.keys(doc).filter((k) => !["suite", "cases"].includes(k));
  if (extra.length > 0) problems.push(`${file}: unknown top-level keys ${extra.join(", ")}`);
  if (!Array.isArray(doc.cases) || doc.cases.length === 0) return [...problems, `${file}: \`cases\` must be a non-empty array`];

  const seen = new Set<string>();
  doc.cases.forEach((c: unknown, i: number) => {
    const at = `${file}#${i}`;
    if (!isRecord(c)) {
      problems.push(`${at}: not an object`);
      return;
    }
    const unknown = Object.keys(c).filter((k) => !(CASE_KEYS as readonly string[]).includes(k));
    if (unknown.length > 0) problems.push(`${at}: unknown case keys ${unknown.join(", ")}`);
    if (typeof c.name !== "string" || c.name === "") problems.push(`${at}: missing \`name\``);
    else if (seen.has(c.name)) problems.push(`${at}: duplicate name '${c.name}'`);
    else seen.add(c.name);
    if (c.notes !== undefined && typeof c.notes !== "string") problems.push(`${at}: \`notes\` must be a string`);
    if (c.config !== undefined) validateConfig(at, c.config, problems);
    const stepCount = validateSteps(at, c.steps, problems, EXTRA_STEPS);
    // A regeneration pass (`requireExpect: false`) rewrites `expect` from the
    // inputs, so a stale one — a projection key the spec gained — is not a problem.
    if (c.expect === undefined || !requireExpect) {
      if (requireExpect) problems.push(`${at}: missing \`expect\` (run MUTATE_SPEC_UPDATE=1)`);
      return;
    }
    validateProjection(`${at}.expect`, c.expect, stepCount, problems);
  });
  return problems;
}
