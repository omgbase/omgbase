// Fixture bridge for spec/mutate (README §9). Pure pieces, no vitest:
//
//   runCase()               §9: run a mutation script — the spec/store §9.4 observation-script
//                           shape plus the `apply` / `macro` / `docs` / `plan` / `disk` steps —
//                           through the production write paths against a fresh `:memory:` store
//                           and an in-memory doc store, check the invariants after every step,
//                           project `files` + the store tables
//   MemoryDocStore          the in-memory `DocStore` (path → bytes) the runner seeds from
//                           `observe` steps so file-CAS and the written bytes are checkable
//   toSpecOp()/toKernelOp() the fixture's op spelling (`child_ids`) ⇄ the reference's (`childIds`)
//   errorOutcome()          a MutationError → the pinned `{ code, op_index?, block?, current?, retriable? }`
//   validateFixtureFile()   the shape check a runner applies before trusting a file
//
// Nothing here decides anything about mutation; it drives the same code paths
// production uses (`apply`, the macros, `docsCreate/Move/Delete/SetMeta`,
// `planUpdate`/`applyOpset`, `observeBatch`) with the fixture minter installed
// and a pinned commit clock, and re-expresses the results so two engines can be
// compared.
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
import { docsCreate, docsDelete, docsMove, docsSetMeta, type DocOpContext } from "../../src/mutate/docs.js";
import { applyOpset, planUpdate } from "../../src/mutate/plan-update.js";
import type { Opset } from "../../src/mutate/opset.js";
import { toReconcileConfig, deepEqualTol, type FixtureConfig } from "../reconcile/fixture.js";
import {
  FIXTURE_REPO_SLUG, TS_RE, checkInvariants, projectStore, toOutcome, validateSteps,
  type ExtraStepValidator, type JsonRow, type Row, type Step as StoreStep, type StepOutcome as StoreStepOutcome,
} from "../store/fixture.js";

export { deepEqualTol, FIXTURE_REPO_SLUG };

// ---- fixture shapes ------------------------------------------------------------

/** The six ops as the fixture spells them (README §2/§4): the reference's `childIds` is `child_ids` here. */
export type SpecOp =
  | { op: "insert"; doc?: string; to: To; markdown: string }
  | { op: "update"; block: string; markdown?: string; attrs?: Record<string, unknown>; expect?: Expect; trivia?: string; child_ids?: Record<string, string> }
  | { op: "move"; blocks: string[]; to: To }
  | { op: "remove"; blocks: string[]; expect?: Record<string, Expect> }
  | { op: "split"; block: string; at: number[]; expect?: Expect }
  | { op: "merge"; blocks: string[]; separator?: string; expect?: Record<string, Expect> };

export interface Origin {
  actor: string;
  reason?: string;
}

export interface ApplyStep {
  /** commit timestamp (spec/store §2.4) — every commit this step records carries it */
  ts: string;
  ops: SpecOp[];
  origin: Origin;
  dry_run?: boolean;
  set_frontmatter?: { doc: string; raw: string | null }[];
}

export const MACROS = [
  "tasks_complete", "sections_append", "docs_append", "sections_rename", "sections_move", "lists_insert_item", "node_set", "links_repair", "links_retarget",
] as const;
export type MacroName = (typeof MACROS)[number];

export interface MacroStep {
  ts: string;
  name: MacroName;
  args: Record<string, unknown>;
  origin: Origin;
}

export const DOC_OPS = ["create", "move", "delete", "set_meta"] as const;
export type DocOpName = (typeof DOC_OPS)[number];

export interface DocsStep {
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
  /** also run `apply_opset` on the plan (README §7.2) */
  apply?: boolean;
  /** the origin `apply_opset` commits under; defaults to `{ actor: "agent:update" }` */
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

export type Step =
  | StoreStep
  | { apply: ApplyStep }
  | { macro: MacroStep }
  | { docs: DocsStep }
  | { plan: PlanStep }
  | { disk: DiskStep };

/** `{ code, op_index?, block?, current?, retriable? }` — README §8's pinned data fields. */
export interface ErrorOutcome {
  error: { code: string; op_index?: number; block?: string; current?: Record<string, unknown>; retriable?: boolean };
}

export interface ApplyOutcome {
  results: { ids: string[]; removed?: string[]; merged_into?: string[] }[];
  revisions: { doc: string; path: string }[];
  diffs?: Record<string, { before: string; after: string }>;
  committed: boolean;
}

export type StepOutcome = StoreStepOutcome | ApplyOutcome | ErrorOutcome | Record<string, unknown>;

export interface Projection {
  steps: StepOutcome[];
  /** the in-memory doc store after the last step, path → bytes, sorted by path */
  files: Record<string, string>;
  docs: Row[];
  blocks: JsonRow[];
  commits: Row[];
  revisions: Row[];
  dispositions: JsonRow[];
  resurrection_pool: Row[];
}

/** The projected tables, in the order the fixture emits them (README §9). */
export const PROJECTED_TABLES = ["docs", "blocks", "commits", "revisions", "dispositions", "resurrection_pool"] as const;

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
export class MemoryDocStore implements DocStore {
  readonly files = new Map<string, string>();
  exists(path: string): boolean {
    return this.files.has(path);
  }
  read(path: string): string | null {
    return this.files.get(path) ?? null;
  }
  write(path: string, bytes: string): void {
    this.files.set(path, bytes);
  }
  rename(from: string, to: string): void {
    const bytes = this.files.get(from);
    if (bytes === undefined) throw new Error(`rename: no file at ${from}`);
    this.files.delete(from);
    this.files.set(to, bytes);
  }
  remove(path: string): void {
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
  return { error };
}

/** An opset as the fixture records it (README §7): snake_case precondition/matcher, fixture-spelled ops. */
export function toSpecOpset(o: Opset): Record<string, unknown> {
  return {
    version: o.version,
    kind: o.kind,
    target: o.target,
    precondition: { doc: o.precondition.doc, path: o.precondition.path, base_revision: o.precondition.baseRevision, base_content_hash: o.precondition.baseContentHash },
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
      const r: Runner = { store, repoId: ensureRepo(store, FIXTURE_REPO_SLUG, null), docStore: new MemoryDocStore(), pendingDisk: new Set(), config: toReconcileConfig(c.config) };
      const steps: StepOutcome[] = [];
      const problems: string[] = [];
      c.steps.forEach((step, i) => {
        steps.push(runStep(r, step));
        for (const p of checkAll(r)) problems.push(`after step ${i}: ${p}`);
      });
      for (const p of checkAll(r)) problems.push(`at end: ${p}`);
      const t = projectStore(store.db, r.repoId);
      return {
        expect: { steps, files: r.docStore.snapshot(), docs: t.docs, blocks: t.blocks, commits: t.commits, revisions: t.revisions, dispositions: t.dispositions, resurrection_pool: t.resurrection_pool },
        problems,
      };
    } finally {
      store.close();
    }
  });
}

function runStep(r: Runner, step: Step): StepOutcome {
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
  if ("disk" in step) {
    r.docStore.write(step.disk.path, step.disk.source);
    r.pendingDisk.add(step.disk.path);
    return {};
  }
  if ("apply" in step) return runApply(r, step.apply);
  if ("macro" in step) return runMacro(r, step.macro);
  if ("docs" in step) return runDocs(r, step.docs);
  return runPlan(r, step.plan);
}

function runApply(r: Runner, s: ApplyStep): ApplyOutcome | ErrorOutcome {
  try {
    return applyOutcome(apply(r.store, {
      repoId: r.repoId,
      docStore: r.docStore,
      ops: s.ops.map(toKernelOp),
      origin: s.origin,
      ...(s.dry_run !== undefined ? { dryRun: s.dry_run } : {}),
      ...(s.set_frontmatter !== undefined ? { setFrontmatter: s.set_frontmatter } : {}),
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
    extra = { hits: p.hits.map((h) => ({ block: h.block, path: h.path, old_raw: h.oldRaw, new_raw: h.newRaw })), pairs: p.pairs };
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

function runDocs(r: Runner, s: DocsStep): StepOutcome {
  const ctx: DocOpContext = { repoId: r.repoId, docStore: r.docStore, ts: s.ts, ...(s.actor !== undefined ? { actor: s.actor } : {}) };
  try {
    if (s.create) {
      const res = docsCreate(r.store, ctx, s.create.path, s.create.markdown, s.create.frontmatter);
      return { doc: res.docId, path: res.path, committed: res.committed };
    }
    if (s.move) {
      const res = docsMove(r.store, ctx, s.move.doc, s.move.to_path, s.move.retarget_inbound !== undefined ? { retargetInbound: s.move.retarget_inbound } : {});
      return { doc: res.docId, path: res.path, committed: res.committed, dangling: res.dangling, retargeted: res.retargeted };
    }
    if (s.delete) {
      const res = docsDelete(r.store, ctx, s.delete.doc);
      return { doc: res.docId, path: res.path, committed: res.committed };
    }
    const m = s.set_meta!;
    const res = docsSetMeta(r.store, ctx, m.doc, { ...(m.set !== undefined ? { set: m.set } : {}), ...(m.unset !== undefined ? { unset: m.unset } : {}) });
    return { doc: res.docId, path: res.path, committed: res.committed };
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
    try {
      out.apply = applyOutcome(applyOpset(r.store, { repoId: r.repoId, docStore: r.docStore, opset, origin: s.origin ?? { actor: "agent:update" }, ts: s.ts }));
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
 * human edit); I1 then runs against the store's own reconstruction.
 */
function checkAll(r: Runner): string[] {
  const db = r.store.db;
  const live = db
    .prepare("SELECT doc_id, path, file_hash FROM docs WHERE repo_id = ? AND deleted_commit IS NULL AND current_rev IS NOT NULL ORDER BY path")
    .all(r.repoId) as { doc_id: string; path: string; file_hash: Buffer | null }[];
  const problems: string[] = [];
  const lastSource = new Map<string, string>();
  for (const d of live) {
    const bytes = r.docStore.read(d.path);
    if (bytes !== null && d.file_hash && sha256(bytes).equals(d.file_hash)) r.pendingDisk.delete(d.path);
    if (r.pendingDisk.has(d.path)) {
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
    onlyKeys(body, ["ts", "ops", "origin", "dry_run", "set_frontmatter"], here, problems);
    requireTs(body, here, problems);
    validateOps(body.ops, here, problems);
    requireOrigin(body.origin, here, problems);
    if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") problems.push(`${here}: \`dry_run\` must be a boolean`);
    if (body.set_frontmatter !== undefined && !Array.isArray(body.set_frontmatter)) problems.push(`${here}: \`set_frontmatter\` must be an array of { doc, raw }`);
  },
  macro: (body, here, problems) => {
    if (!isRecord(body)) {
      problems.push(`${here}: not an object`);
      return;
    }
    onlyKeys(body, ["ts", "name", "args", "origin"], here, problems);
    requireTs(body, here, problems);
    if (typeof body.name !== "string" || !(MACROS as readonly string[]).includes(body.name)) problems.push(`${here}: \`name\` must be one of ${MACROS.join("/")}`);
    if (!isRecord(body.args)) problems.push(`${here}: \`args\` must be an object`);
    requireOrigin(body.origin, here, problems);
  },
  docs: (body, here, problems) => {
    if (!isRecord(body)) {
      problems.push(`${here}: not an object`);
      return;
    }
    onlyKeys(body, ["ts", "actor", ...DOC_OPS], here, problems);
    requireTs(body, here, problems);
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
};

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
    if (c.expect === undefined) {
      if (requireExpect) problems.push(`${at}: missing \`expect\` (run MUTATE_SPEC_UPDATE=1)`);
      return;
    }
    validateProjection(`${at}.expect`, c.expect, stepCount, problems);
  });
  return problems;
}
