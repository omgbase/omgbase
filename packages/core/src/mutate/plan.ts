import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";
import { observeMints, withIdMinter } from "../core/ids.js";
import { findDoc } from "../core/read/reader.js";
import { inboundLinksTo } from "../graph/inbound-links.js";
import { withWriterLock } from "../sync/writer-lock.js";
import { ChangesetPlanner, type ApplyRevision, type ChangesetPlan, type Op, type OpResult } from "./apply.js";
import { commitChangeset, readDocBase, type CommitHead, type Effect as InternalEffect } from "./commit.js";
import { resolveDocStore, type DocStore } from "./doc-store.js";
import { composeFile } from "./docs.js";
import {
  ConflictTracker, SymbolTable, lowerEffect, symbolicMinter, validateEffects, effectInvalid,
  type Effect, type LoweringContext, type ResolvedEffect,
} from "./effects.js";
import { MutationError } from "./tree.js";

// The Plan (spec/mutate §11.4–§11.7, 2.3): the frozen, executable, digest-named
// result of lowering an ordered effect list. `plan` writes nothing; `execute`
// commits exactly a plan — its preconditions re-validated inside the
// transaction by `commit.ts` — and `apply({ effects })` is plan + execute under
// one writer lock and one transaction. New identities are symbolic (`$new.n`,
// minted at execute, mapped in the receipt); a plan's identity is the sha256 of
// the canonical JSON of its executable core.

export const PLAN_VERSION = 1 as const;
/** The lowering + conflict rules version (§11.4; the `matcher_v` precedent). */
export const PLANNER_V = "p1" as const;

/** A kernel op as the plan spells it on the wire: the fixture spelling (`child_ids`). */
export type WireOp =
  | Exclude<Op, { op: "update" }>
  | { op: "update"; block: string; markdown?: string; attrs?: Record<string, unknown>; expect?: { content_hash?: string; parent_children_hash?: string }; trivia?: string; child_ids?: Record<string, string> };

/** The lowered form `execute` replays (§11.4): every key present, `[]` when empty. */
export interface PlanOpset {
  /** `create` → the composed file (`set`/`unset frontmatter.<k>` on `$new.n` folded in) */
  creates: { path: string; source: string }[];
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
}

/** The executable core the digest covers. */
export interface PlanCore {
  version: typeof PLAN_VERSION;
  planner_v: string;
  effects: ResolvedEffect[];
  opset: PlanOpset;
  preconditions: PlanPreconditions;
  new_ids: { symbol: string; kind: "block" | "document" }[];
}

export interface Plan extends PlanCore {
  plan_id: string;
  diagnostics: string[];
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
}

// ---- canonical JSON and the digest (§11.5) ----------------------------------------------

function cmpUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

// A lone surrogate has no UTF-8 encoding: it cannot be digested (nor sent as JSON text).
function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

function canonicalString(s: string): string {
  if (!isWellFormed(s)) throw effectInvalid("strings must be well-formed Unicode (a lone surrogate cannot be digested)");
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x22: out += '\\"'; break;
      case 0x5c: out += "\\\\"; break;
      case 0x08: out += "\\b"; break;
      case 0x0c: out += "\\f"; break;
      case 0x0a: out += "\\n"; break;
      case 0x0d: out += "\\r"; break;
      case 0x09: out += "\\t"; break;
      default:
        out += c < 0x20 ? `\\u${c.toString(16).padStart(4, "0")}` : s[i]!;
    }
  }
  return out + '"';
}

function canonicalNumber(n: number): string {
  if (!Number.isFinite(n)) throw effectInvalid("a number in a plan must be finite");
  if (Number.isInteger(n) && Math.abs(n) < 2 ** 53) return String(n === 0 ? 0 : n);
  return String(n);
}

/**
 * Canonical JSON (§11.5): no whitespace; object keys sorted by their UTF-8
 * bytes; members whose value is `undefined` omitted (an optional key absent is
 * absent, never `null`; a JSON `null` value stays `null`); strings escaped only
 * as JSON requires — `"`, `\`, and U+0000–U+001F (`\b \f \n \r \t`, else
 * `\u00xx` lower-case) — everything else literal UTF-8; a number that is
 * integral with |n| < 2^53 printed as a plain integer (`-0` as `0`), any other
 * finite number by ECMAScript `Number::toString` (shortest round-trip digits);
 * `true`/`false`/`null`.
 */
export function canonicalJson(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      return canonicalNumber(v);
    case "string":
      return canonicalString(v);
    case "object": {
      if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(",")}]`;
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort(cmpUtf8);
      return `{${keys.map((k) => `${canonicalString(k)}:${canonicalJson(o[k])}`).join(",")}}`;
    }
    default:
      throw effectInvalid(`a ${typeof v} cannot be digested`);
  }
}

/** The executable core of a plan — the six digested keys, nothing else. */
export function planCore(p: PlanCore): PlanCore {
  return { version: p.version, planner_v: p.planner_v, effects: p.effects, opset: p.opset, preconditions: p.preconditions, new_ids: p.new_ids };
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
  /** The effects as given (validated here: a shape error is `filter_invalid`). */
  effects: unknown;
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
  const effects: Effect[] = validateEffects(req.effects);
  const docStore = resolveDocStore(req);
  const symbols = new SymbolTable();
  return withIdMinter(symbolicMinter(symbols), () => {
    const planner = new ChangesetPlanner(store, req.repoId, req.omgbaseDir);
    const ctx: LoweringContext = {
      store, repoId: req.repoId, docStore, planner, symbols,
      blockSymbols: new Map(), creates: new Map(), moves: [], tombstones: [], heads: new Map(), ops: [],
      pins: new Map(), parents: [], absentPaths: [], docBases: new Map(),
      tracker: new ConflictTracker(canonicalJson), canonical: canonicalJson, resolved: [],
    };
    effects.forEach((e, i) => {
      try {
        lowerEffect(ctx, i, e);
      } catch (err) {
        // Every failure names the effect it arose from (the kernel's own data — `op_index`, `block` — stays).
        if (err instanceof MutationError && err.data.effect_index === undefined) err.data = { ...err.data, effect_index: i };
        throw err;
      }
    });
    const changeset = planner.finish();

    const creates = [...ctx.creates.values()].map((d) => ({ symbol: d.symbol, path: d.path, source: composeFile(d.markdown, d.frontmatter) }));
    const opset: PlanOpset = {
      creates: creates.map((c) => ({ path: c.path, source: c.source })),
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
    const core: PlanCore = { version: PLAN_VERSION, planner_v: PLANNER_V, effects: ctx.resolved, opset, preconditions, new_ids: symbols.entries };
    const plan_id = planDigest(core);

    // The preview (not digested): the kernel results, every revision the commit
    // would record, and the per-file diffs — a create `"" → bytes`, a move two
    // entries (its retargeted bytes land at the new path), a removal `bytes → ""`.
    const diffs: Record<string, { before: string; after: string }> = { ...changeset.diffs };
    const revisions: ApplyRevision[] = [...changeset.revisions];
    for (const c of creates) {
      diffs[c.path] = { before: "", after: c.source };
      revisions.push({ id: c.symbol, path: c.path, hash: sha256(c.source).toString("hex") });
    }
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
    return { ...core, plan_id, diagnostics: ctx.tracker.diagnostics, preview: { results: changeset.results, revisions, diffs } };
  });
}

// ---- executing (§11.7) --------------------------------------------------------------------

export interface ExecuteRequest {
  repoId: string;
  rootPath?: string;
  docStore?: DocStore;
  omgbaseDir?: string;
  origin: { actor: string; reason?: string };
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
  if (!isRecord(input.preconditions)) throw effectInvalid("`plan.preconditions` must be an object");
  for (const k of ["docs", "blocks", "parents", "absent_paths"]) {
    if (!Array.isArray(input.preconditions[k])) throw effectInvalid(`\`plan.preconditions.${k}\` must be an array`);
  }
  if (!Array.isArray(input.new_ids)) throw effectInvalid("`plan.new_ids` must be an array");
  if (typeof input.plan_id !== "string") throw effectInvalid("`plan.plan_id` must be a string");
  const plan = input as unknown as Plan;
  const actual = planDigest(plan);
  if (actual !== plan.plan_id) {
    throw new MutationError("plan_mismatch", "the plan's digest does not match its plan_id; it was edited or produced by a different planner — re-plan", { expected: plan.plan_id, actual });
  }
  return plan;
}

/** `execute { plan }` (§11.7): admit, then commit exactly that plan. */
export function executePlan(store: Store, req: ExecuteRequest & { plan: unknown }): Receipt {
  const plan = admitPlan(req.plan);
  const docStore = resolveDocStore(req);
  return underLock(req, () => executeAdmitted(store, req, plan, docStore));
}

/** `execute { plan_id, effects }` (§11.7): re-plan; the digest must equal `plan_id`, else `plan_mismatch`. */
export function executeByDigest(store: Store, req: ExecuteRequest & { planId: string; effects: unknown }): Receipt {
  const docStore = resolveDocStore(req);
  return underLock(req, () => {
    const plan = planEffects(store, { repoId: req.repoId, docStore, ...(req.omgbaseDir !== undefined ? { omgbaseDir: req.omgbaseDir } : {}), effects: req.effects });
    if (plan.plan_id !== req.planId) {
      throw new MutationError("plan_mismatch", "the effects or the documents they target changed since the plan was made; re-plan", { expected: req.planId, actual: plan.plan_id });
    }
    return executeAdmitted(store, req, plan, docStore);
  });
}

/** `apply { effects }` (§11.7): plan + execute under one lock and one transaction; `dryRun` returns the Plan. */
export function applyEffects(store: Store, req: ExecuteRequest & { effects: unknown; dryRun?: boolean }): Plan | Receipt {
  const docStore = resolveDocStore(req);
  const planIt = (): Plan => planEffects(store, { repoId: req.repoId, docStore, ...(req.omgbaseDir !== undefined ? { omgbaseDir: req.omgbaseDir } : {}), effects: req.effects });
  if (req.dryRun) return planIt();
  return underLock(req, () => executeAdmitted(store, req, planIt(), docStore));
}

function underLock<T>(req: { omgbaseDir?: string }, fn: () => T): T {
  return req.omgbaseDir ? withWriterLock(req.omgbaseDir, fn) : fn();
}

/**
 * Commit an admitted plan: the preconditions pre-checked (`stale_plan` /
 * `doc_missing` / `path_taken`, outside the transaction, so a stale plan fails
 * before any id is minted), the opset replayed under the production minter
 * (`b` ids minted here, before the transaction — as every request's are), the
 * internal effects built in order — creates, moves, the rendered documents (a
 * moved document's revision lands at its new path), tombstones — and
 * `commitChangeset` re-validates every triple inside `BEGIN IMMEDIATE`. The
 * commit row's `ops` is the intent record `canonical({ v: 1, plan_id, effects })`.
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
    ops: canonicalJson({ v: 1, plan_id: plan.plan_id, effects: plan.effects }),
  };
  const stat = req.omgbaseDir !== undefined;
  const moved = new Map(plan.opset.moves.map((m) => [m.id, m]));

  const { effects, outcome } = observeMints(
    (prefix, id) => {
      if (prefix === "b") minted.b.push(id);
      else if (prefix === "d") minted.d.push(id);
    },
    () => {
      const planner = new ChangesetPlanner(store, req.repoId, req.omgbaseDir);
      for (const h of plan.opset.set_frontmatter) planner.setHead(h.doc, h.raw);
      for (const op of plan.opset.ops) planner.push(kernelOp(op));
      const changeset: ChangesetPlan = planner.finish();

      const effects: InternalEffect[] = [];
      for (const c of plan.opset.creates) {
        effects.push({ kind: "ingest_reconciled", path: c.path, source: c.source, precondition: null });
        if (stat) effects.push({ kind: "record_stat", path: c.path, bytes: c.source });
      }
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

  // The receipt's revisions, in effect order; the ingest results pair with the ingest effects in order.
  const revisions: ApplyRevision[] = [];
  let j = 0;
  for (const e of effects) {
    if (e.kind === "ingest_reconciled") revisions.push({ id: outcome.ingests[j++]!.docId, path: e.path, hash: sha256(e.source).toString("hex") });
    else if (e.kind === "ingest_known") {
      j++;
      revisions.push({ id: e.docId, path: e.path, hash: sha256(e.rendered).toString("hex") });
    }
  }
  // `$new.n` → minted id: the i-th block symbol is the i-th `b` the replay
  // minted (all before the transaction, in the plan's order), the i-th document
  // symbol the i-th `d` the creates minted inside it.
  const newIds: Record<string, string> = {};
  let bi = 0;
  let di = 0;
  for (const s of plan.new_ids) {
    const id = s.kind === "block" ? minted.b[bi++] : minted.d[di++];
    if (id !== undefined) newIds[s.symbol] = id;
  }
  return { plan_id: plan.plan_id, commit: outcome.commitId, revisions, new_ids: newIds, committed: true };
}
