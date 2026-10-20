import type { Store } from "../core/store/store.js";
import { findDoc } from "../core/read/reader.js";
import { normalizeVisibleText } from "../core/hash.js";
import { referencePath } from "../core/paths.js";
import { isValidId, withIdMinter, type IdMinter } from "../core/ids.js";
import { inboundLinksTo, type InboundLink } from "../graph/inbound-links.js";
import type { ChangesetPlanner, Op } from "./apply.js";
import { readDocBase, type DocBase } from "./commit.js";
import type { DocStore } from "./doc-store.js";
import { adapterForPath } from "../format/index.js";
import { canonicalDocPath, composeFile, parseNewDoc, planInboundRetarget, splitFrontmatter } from "./docs.js";
import { linksRepair, nodeSet, type LinkRepairCount, type RetargetHit } from "./macros.js";
import type { At, Expect, To } from "./ops.js";
import type { IdentityPreview } from "./opset.js";
import { planUpdate } from "./plan-update.js";
import { MutationError, rawHashHex, renderDoc, type MutBlock, type MutDoc } from "./tree.js";
import { fixRequest, withMember, type FixRequest } from "./canonical.js";
import { joinFrontmatterParts, leadOf, lineEndingOf, splitFrontmatterRaw, splitFrontmatterTrivia } from "./frontmatter-parts.js";
import { stringify as stringifyYaml } from "yaml";

// The public Effect layer (spec/mutate §11, 2.3; ADR-021). Nine effects —
// `create insert set unset move remove split merge retarget` — are the
// intentional-write vocabulary and a PLANNER TIER over the six-op kernel: each
// lowers deterministically to today's kernel ops (`apply.ts`), the macros
// (`macros.ts`), the whole-document planner (`plan-update.ts`) and the
// internal document effects `commit.ts` runs (`ingest_reconciled`, `move_path`,
// `tombstone`). Nothing is added to the kernel. This module is the pure half:
// the vocabulary and its validation, target and `$new.n` resolution, the focus
// classification with the conflict rules, and the lowering of one effect into
// a `ChangesetPlanner` + the document-level drafts. `plan.ts` drives it under
// the symbolic minter and freezes the result into a Plan.

// ---- the vocabulary (§11.1) ------------------------------------------------------

/** What an effect addresses. `section` is a derived range (ADR-005), never a stored id.
 *  `symbol` (3.2, §11.8 "Sugar"): a bare `"$new.n"` target whose kind — document or block — the
 *  symbol table decides when the effect is resolved; it never reaches a resolved effect. */
export type EffectTarget =
  | { kind: "document"; _id?: string; _path?: string }
  | { kind: "block"; _id: string }
  | { kind: "node"; _id: string }
  | { kind: "section"; heading_id: string }
  | { kind: "symbol"; _id: string };

export type EffectAt = At;

/** Guards: the kernel's two CAS fields plus the document's `current_rev` at plan time. */
export interface EffectExpect {
  content_hash?: string;
  parent_children_hash?: string;
  revision?: string;
}

/** Per-block guards for `remove`/`merge` (the kernel's `expect[id]`), keyed by block id. */
export type EffectExpectMap = Record<string, Expect>;

export type Effect =
  | { op: "create"; path: string; markdown: string; frontmatter?: Record<string, unknown> }
  | { op: "insert"; into: EffectTarget; at?: EffectAt; markdown: string; expect?: EffectExpect }
  | { op: "set"; target: EffectTarget; field: string; value: unknown; expect?: EffectExpect }
  | { op: "unset"; target: EffectTarget; field: string; expect?: EffectExpect }
  | { op: "move"; target: EffectTarget; to: string; retarget_inbound?: boolean }
  | { op: "move"; targets: EffectTarget[]; into: EffectTarget; at?: EffectAt; expect?: EffectExpect }
  | { op: "remove"; target: EffectTarget }
  | { op: "remove"; targets: EffectTarget[]; expect?: EffectExpectMap }
  | { op: "split"; target: EffectTarget; at: number[]; expect?: EffectExpect }
  | { op: "merge"; targets: EffectTarget[]; separator?: string; expect?: EffectExpectMap }
  | { op: "retarget"; repairs: { from: string; to: string }[]; path_glob?: string };

export const EFFECT_OPS = ["create", "insert", "set", "unset", "move", "remove", "split", "merge", "retarget"] as const;

/** `$new.<n>`: an identity an earlier effect of the same request creates (§11.1). */
export const NEW_SYMBOL_RE = /^\$new\.(0|[1-9][0-9]*)$/;
export function isNewSymbol(s: string): boolean {
  return NEW_SYMBOL_RE.test(s);
}

// ---- resolved effects (§11.4 `effects`) ----------------------------------------------

/** A target with its document resolved to `{ _id, _path }` (path in the storage form; a `$new.n` document keeps its symbol). */
export type ResolvedTarget =
  | { kind: "document"; _id: string; _path: string }
  | { kind: "block"; _id: string }
  | { kind: "node"; _id: string }
  | { kind: "section"; heading_id: string };

export type ResolvedEffect =
  | { op: "create"; path: string; markdown: string; frontmatter?: Record<string, unknown> }
  | { op: "insert"; into: ResolvedTarget; at: EffectAt; markdown: string; expect?: EffectExpect }
  | { op: "set"; target: ResolvedTarget; field: string; value: unknown; expect?: EffectExpect }
  | { op: "unset"; target: ResolvedTarget; field: string; expect?: EffectExpect }
  | { op: "move"; target: ResolvedTarget; to: string; retarget_inbound: boolean }
  | { op: "move"; targets: ResolvedTarget[]; into: ResolvedTarget; at: EffectAt; expect?: EffectExpect }
  | { op: "remove"; target: ResolvedTarget }
  | { op: "remove"; targets: ResolvedTarget[]; expect?: EffectExpectMap }
  | { op: "split"; target: ResolvedTarget; at: number[]; expect?: EffectExpect }
  | { op: "merge"; targets: ResolvedTarget[]; separator: string; expect?: EffectExpectMap }
  | { op: "retarget"; repairs: { from: string; to: string }[]; path_glob?: string };

// ---- validation (§11.1; a malformed effect is `filter_invalid` with `hint: "arguments"`) ----

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The argument-shape error of the surface, thrown from the planner: `filter_invalid { reason, hint: "arguments" }` — with a `fix` (3.4, §8) when the shape check can spell the corrected call. */
export function effectInvalid(message: string, fix?: string): MutationError {
  return new MutationError("filter_invalid", message, { reason: message, hint: "arguments", ...(fix !== undefined ? { fix } : {}) });
}

/**
 * What the shape check needs to spell a `fix` for the shape errors of §8
 * (3.4): the request as given (the corrected call is that request with the
 * offending effect rewritten — the effect at `effects[i]` AS WRITTEN, before
 * any desugaring) and a live-row lookup for the one fix that needs the store:
 * `parentOf(block id)` → the block's parent id (`null` at the top level) and
 * its document's path (storage form), or `null` when no live block has the id
 * (then there is no fix). The planner's compile (`select.ts`) supplies it; a
 * library call without it gets the same errors with no `fix`.
 */
export interface ShapeFixContext {
  request: FixRequest;
  parentOf: (blockId: string) => { parent: string | null; path: string } | null;
}

/** The fixer of one effect: `build(effect, expect?)` is the request with `effects[i]` replaced by `effect` (and, when given, its top-level `expect` replaced), canonical. */
interface EffectFixer {
  /** the effect as written in the request (the base every corrected effect is spelled from) */
  written: Record<string, unknown>;
  build: (effect: Record<string, unknown>, expect?: { value: unknown }) => string;
  parentOf: ShapeFixContext["parentOf"];
  request: FixRequest;
}

function fixerFor(ctx: ShapeFixContext | undefined, i: number, v: Record<string, unknown>): EffectFixer | undefined {
  if (ctx === undefined) return undefined;
  const list = Array.isArray(ctx.request.effects) ? (ctx.request.effects as unknown[]) : undefined;
  const written = list !== undefined && isRecord(list[i]) ? (list[i] as Record<string, unknown>) : v;
  return {
    written,
    build: (effect, expect) => fixRequest({
      ...ctx.request,
      effects: withMember(ctx.request.effects, [String(i)], effect),
      ...(expect !== undefined ? { expect: expect.value } : {}),
    }),
    parentOf: ctx.parentOf,
    request: ctx.request,
  };
}

/** A record whose every value is a string. */
function isStringRecord(v: unknown): v is Record<string, string> {
  return isRecord(v) && Object.values(v).every((x) => typeof x === "string");
}

/**
 * §8 (3.4): an effect-level `expect.max` — the bound belongs to the request's
 * top-level `expect`, beside `select`. The fix drops it from the effect (the
 * rest of that `expect` stays; an emptied `expect` goes) and, when the request
 * has a `select`, moves it to the top level unless a top-level `expect.max` is
 * already there (then the top-level one is kept as written); without a
 * `select` a top-level `expect` would itself be refused, so the fix only drops it.
 */
function effectLevelMax(v: Record<string, unknown>, here: string, f: EffectFixer | undefined): MutationError {
  const message = `${here}: \`expect.max\` bounds a selection — it is the request's top-level \`expect\`, beside \`select\`, not an effect's`;
  if (f === undefined) return effectInvalid(message);
  const { max, ...rest } = v;
  const effect: Record<string, unknown> = { ...f.written, expect: Object.keys(rest).length > 0 ? rest : undefined };
  if (f.request.select === undefined) return effectInvalid(message, f.build(effect));
  const top = isRecord(f.request.expect) ? f.request.expect : {};
  return effectInvalid(message, f.build(effect, { value: "max" in top ? top : { ...top, max } }));
}

/**
 * §8 (3.4): `at` given as the bare string `"after"` / `"before"` with a block
 * `into` — "right after block X" is `into: X's parent, at: { after: X }`. The
 * fix needs the block's live row (its parent, or its document when it is top-
 * level, spelled as the rooted path); a block the store does not know gets no fix.
 */
function bareAnchor(at: "before" | "after", into: EffectTarget, here: string, f: EffectFixer | undefined): MutationError {
  const message = `${here}: \`at\` must be "start", "end", { before: <block id> } or { after: <block id> } — "${at} block X" is into: X's parent (a block, or the document when X is top-level), at: { ${at}: X }`;
  if (f === undefined || into.kind !== "block") return effectInvalid(message);
  const row = f.parentOf(into._id);
  if (row === null) return effectInvalid(message);
  const parent: unknown = row.parent === null ? referencePath(row.path) : { kind: "block", _id: row.parent };
  return effectInvalid(message, f.build({ ...f.written, into: parent, at: { [at]: into._id } }));
}

/**
 * §8 (3.4): a plural-target `expect` written as `{ content_hash: { <id>: <hash>, … } }`
 * (every key a guard name, every value a map of strings) — the fix inverts the
 * nesting to `{ <id>: { content_hash: <hash> }, … }`.
 */
function invertedExpectMap(v: Record<string, unknown>, here: string, f: EffectFixer | undefined): MutationError | null {
  const keys = Object.keys(v);
  if (keys.length === 0 || !keys.every((k) => k === "content_hash" || k === "parent_children_hash") || !Object.values(v).every(isStringRecord)) return null;
  const message = `${here}: a plural-target \`expect\` is keyed by block id — { <block id>: { content_hash?, parent_children_hash? }, … }`;
  if (f === undefined) return effectInvalid(message);
  const inverted: Record<string, Record<string, string>> = {};
  for (const [guard, byId] of Object.entries(v) as [string, Record<string, string>][]) {
    for (const [id, hash] of Object.entries(byId)) inverted[id] = { ...inverted[id], [guard]: hash };
  }
  return effectInvalid(message, f.build({ ...f.written, expect: inverted }));
}

/** §8 (3.4): the block-field misspellings the fix corrects to `markdown`. */
const BLOCK_FIELD_ALIASES: ReadonlySet<string> = new Set(["text", "content", "body", "raw"]);

function onlyKeys(e: Record<string, unknown>, allowed: readonly string[], here: string): void {
  const extra = Object.keys(e).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw effectInvalid(`${here}: unknown key${extra.length > 1 ? "s" : ""} ${extra.map((k) => `\`${k}\``).join(", ")}`);
}

function requireString(e: Record<string, unknown>, key: string, here: string): string {
  const v = e[key];
  if (typeof v !== "string") throw effectInvalid(`${here}: \`${key}\` must be a string`);
  return v;
}

function optionalString(e: Record<string, unknown>, key: string, here: string): string | undefined {
  const v = e[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw effectInvalid(`${here}: \`${key}\` must be a string`);
  return v;
}

/** The `-> ` leader (3.2, §11.8 "Sugar"): a string beginning exactly so is an OQX expression, the rest of the string. */
export const EXPRESSION_LEADER = "-> ";

/** A path-looking string: contains `/` or ends `.md` (the bare document target of §11.8 "Sugar"). */
export function looksLikePath(s: string): boolean {
  return s.includes("/") || s.endsWith(".md");
}

/** A node id: `n_` + 12 hex (content-hash derived, `core/store/nodes.ts`; the `resolveRef` rule). */
const NODE_ID_RE = /^n_[0-9a-f]{12}$/;

/** A bare id of the three target kinds (§11.8 "Sugar"). */
export function isTargetId(s: string): boolean {
  return isValidId(s, "b") || isValidId(s, "d") || NODE_ID_RE.test(s);
}

/**
 * A bare string where a target object is expected (3.2, §11.8 "Sugar"): a
 * path-looking string → `{ kind: "document", _path }`; a `b_`/`d_`/`n_` id →
 * that kind; `$new.n` → `{ kind: "symbol", _id }` (its kind is the symbol
 * table's at resolution); a `#` locator → `filter_invalid` with a `fix`;
 * anything else is no target. A `-> ` leader never reaches here from the
 * planner (`select.ts` desugars it first); as a library input it is refused
 * the same way, naming the planner.
 */
export function bareTarget(ref: string, here: string): EffectTarget {
  if (ref.startsWith(EXPRESSION_LEADER)) {
    const reason = `${here}: a \`-> \` expression target is bound by the planner (\`plan\` / \`apply\` / \`execute\`), not by the shape check`;
    throw new MutationError("filter_invalid", reason, { reason, hint: "selection" });
  }
  if (ref.includes("#")) {
    const reason = `${here}: ${JSON.stringify(ref)} is a locator, not a target — a bare target is a document path, a \`b_\`/\`d_\`/\`n_\` id or \`$new.n\``;
    throw new MutationError("filter_invalid", reason, { reason, hint: "arguments", fix: "resolve the locator to an id first: `blocks_resolve { locator }`, or a `query` whose hit is the block" });
  }
  if (isNewSymbol(ref)) return { kind: "symbol", _id: ref };
  if (isValidId(ref, "b")) return { kind: "block", _id: ref };
  if (isValidId(ref, "d")) return { kind: "document", _id: ref };
  if (NODE_ID_RE.test(ref)) return { kind: "node", _id: ref };
  if (looksLikePath(ref)) return { kind: "document", _path: ref };
  throw effectInvalid(`${here}: a target is { kind: …, … } or a bare document path, a \`b_\`/\`d_\`/\`n_\` id or \`$new.n\` (got ${JSON.stringify(ref)})`);
}

export function validateTarget(v: unknown, here: string, kinds: readonly EffectTarget["kind"][]): EffectTarget {
  if (typeof v === "string") v = bareTarget(v, here);
  if (!isRecord(v) || typeof v.kind !== "string") throw effectInvalid(`${here}: a target is { kind: ${kinds.map((k) => `"${k}"`).join(" | ")}, … }`);
  // A bare `$new.n` defers its kind check to resolution (`resolveEffect`); the `kinds` are the slot's.
  if (v.kind === "symbol" && typeof v._id === "string" && isNewSymbol(v._id) && Object.keys(v).length === 2) return { kind: "symbol", _id: v._id };
  if (!(kinds as readonly string[]).includes(v.kind)) throw effectInvalid(`${here}: \`kind\` must be one of ${kinds.join(", ")} (got "${v.kind}")`);
  switch (v.kind as Exclude<EffectTarget["kind"], "symbol">) {
    case "document": {
      onlyKeys(v, ["kind", "_id", "_path"], here);
      const id = optionalString(v, "_id", here);
      const path = optionalString(v, "_path", here);
      if (id === undefined && path === undefined) throw effectInvalid(`${here}: a document target needs \`_id\` or \`_path\``);
      return { kind: "document", ...(id !== undefined ? { _id: id } : {}), ...(path !== undefined ? { _path: path } : {}) };
    }
    case "block":
      onlyKeys(v, ["kind", "_id"], here);
      return { kind: "block", _id: requireString(v, "_id", here) };
    case "node":
      onlyKeys(v, ["kind", "_id"], here);
      return { kind: "node", _id: requireString(v, "_id", here) };
    case "section":
      onlyKeys(v, ["kind", "heading_id"], here);
      return { kind: "section", heading_id: requireString(v, "heading_id", here) };
  }
}

function validateTargets(v: unknown, here: string): EffectTarget[] {
  if (!Array.isArray(v) || v.length === 0) throw effectInvalid(`${here}: \`targets\` must be a non-empty array of block targets`);
  return v.map((t, i) => validateTarget(t, `${here}.targets[${i}]`, ["block"]));
}

function validateAt(v: unknown, here: string, into?: EffectTarget, f?: EffectFixer): EffectAt | undefined {
  if (v === undefined) return undefined;
  if (v === "start" || v === "end") return v;
  if (isRecord(v) && Object.keys(v).length === 1) {
    if (typeof v.before === "string") return { before: v.before };
    if (typeof v.after === "string") return { after: v.after };
  }
  if ((v === "before" || v === "after") && into !== undefined) throw bareAnchor(v, into, here, f);
  throw effectInvalid(`${here}: \`at\` must be "start", "end", { before: <block id> } or { after: <block id> }`);
}

function validateExpect(v: unknown, here: string, f?: EffectFixer): EffectExpect | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v)) throw effectInvalid(`${here}: \`expect\` must be an object`);
  if ("max" in v) throw effectLevelMax(v, here, f);
  onlyKeys(v, ["content_hash", "parent_children_hash", "revision"], `${here}.expect`);
  const out: EffectExpect = {};
  for (const k of ["content_hash", "parent_children_hash", "revision"] as const) {
    const s = optionalString(v, k, `${here}.expect`);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

function validateExpectMap(v: unknown, here: string, f?: EffectFixer): EffectExpectMap | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v)) throw effectInvalid(`${here}: \`expect\` must be an object keyed by block id`);
  if ("max" in v) throw effectLevelMax(v, here, f);
  const inverted = invertedExpectMap(v, here, f);
  if (inverted !== null) throw inverted;
  const out: EffectExpectMap = {};
  for (const [id, x] of Object.entries(v)) {
    if (!isRecord(x)) throw effectInvalid(`${here}.expect[${JSON.stringify(id)}]: must be an object`);
    onlyKeys(x, ["content_hash", "parent_children_hash"], `${here}.expect[${JSON.stringify(id)}]`);
    const e: Expect = {};
    const ch = optionalString(x, "content_hash", `${here}.expect[${JSON.stringify(id)}]`);
    const pch = optionalString(x, "parent_children_hash", `${here}.expect[${JSON.stringify(id)}]`);
    if (ch !== undefined) e.content_hash = ch;
    if (pch !== undefined) e.parent_children_hash = pch;
    out[id] = e;
  }
  return out;
}

/** The shape check of one effect (§11.1). `i` names it in the message (`effects[i]`); `fix` (3.4) lets the shape errors of §8 carry their corrected call. */
export function validateEffect(v: unknown, i: number, fix?: ShapeFixContext): Effect {
  const here = `effects[${i}]`;
  if (!isRecord(v) || typeof v.op !== "string") throw effectInvalid(`${here}: an effect is an object whose \`op\` is one of ${EFFECT_OPS.join("/")}`);
  if (!(EFFECT_OPS as readonly string[]).includes(v.op)) throw effectInvalid(`${here}: \`op\` must be one of ${EFFECT_OPS.join("/")} (got "${v.op}")`);
  const f = fixerFor(fix, i, v);
  switch (v.op as Effect["op"]) {
    case "create": {
      onlyKeys(v, ["op", "path", "markdown", "frontmatter"], here);
      const path = requireString(v, "path", here);
      const markdown = requireString(v, "markdown", here);
      if (v.frontmatter !== undefined && !isRecord(v.frontmatter)) throw effectInvalid(`${here}: \`frontmatter\` must be an object`);
      return { op: "create", path, markdown, ...(v.frontmatter !== undefined ? { frontmatter: v.frontmatter as Record<string, unknown> } : {}) };
    }
    case "insert": {
      onlyKeys(v, ["op", "into", "at", "markdown", "expect"], here);
      const into = validateTarget(v.into, `${here}.into`, ["document", "section", "block"]);
      const at = validateAt(v.at, here, into, f);
      const markdown = requireString(v, "markdown", here);
      const expect = validateExpect(v.expect, here, f);
      return { op: "insert", into, ...(at !== undefined ? { at } : {}), markdown, ...(expect !== undefined ? { expect } : {}) };
    }
    case "set": {
      onlyKeys(v, ["op", "target", "field", "value", "expect"], here);
      const target = validateTarget(v.target, `${here}.target`, ["document", "block", "node"]);
      const field = requireString(v, "field", here);
      if (!("value" in v)) throw effectInvalid(`${here}: \`value\` is required`);
      if (target.kind !== "symbol") checkField(target.kind, field, here, "set", f);
      const expect = validateExpect(v.expect, here, f);
      return { op: "set", target, field, value: v.value, ...(expect !== undefined ? { expect } : {}) };
    }
    case "unset": {
      onlyKeys(v, ["op", "target", "field", "expect"], here);
      const target = validateTarget(v.target, `${here}.target`, ["document"]);
      const field = requireString(v, "field", here);
      if (target.kind !== "symbol") checkField(target.kind, field, here, "unset");
      const expect = validateExpect(v.expect, here, f);
      return { op: "unset", target, field, ...(expect !== undefined ? { expect } : {}) };
    }
    case "move": {
      if ("targets" in v) {
        onlyKeys(v, ["op", "targets", "into", "at", "expect"], here);
        const targets = validateTargets(v.targets, here);
        const into = validateTarget(v.into, `${here}.into`, ["document", "section", "block"]);
        const at = validateAt(v.at, here, into, f);
        const expect = validateExpect(v.expect, here, f);
        return { op: "move", targets, into, ...(at !== undefined ? { at } : {}), ...(expect !== undefined ? { expect } : {}) };
      }
      onlyKeys(v, ["op", "target", "to", "retarget_inbound"], here);
      const target = validateTarget(v.target, `${here}.target`, ["document"]);
      const to = requireString(v, "to", here);
      if (v.retarget_inbound !== undefined && typeof v.retarget_inbound !== "boolean") throw effectInvalid(`${here}: \`retarget_inbound\` must be a boolean`);
      return { op: "move", target, to, ...(v.retarget_inbound !== undefined ? { retarget_inbound: v.retarget_inbound } : {}) };
    }
    case "remove": {
      if ("targets" in v) {
        onlyKeys(v, ["op", "targets", "expect"], here);
        const targets = validateTargets(v.targets, here);
        const expect = validateExpectMap(v.expect, here, f);
        return { op: "remove", targets, ...(expect !== undefined ? { expect } : {}) };
      }
      onlyKeys(v, ["op", "target"], here);
      return { op: "remove", target: validateTarget(v.target, `${here}.target`, ["document"]) };
    }
    case "split": {
      onlyKeys(v, ["op", "target", "at", "expect"], here);
      const target = validateTarget(v.target, `${here}.target`, ["block"]);
      if (!Array.isArray(v.at) || v.at.some((n) => typeof n !== "number" || !Number.isInteger(n) || n < 0)) throw effectInvalid(`${here}: \`at\` must be an array of byte offsets`);
      const expect = validateExpect(v.expect, here, f);
      return { op: "split", target, at: v.at as number[], ...(expect !== undefined ? { expect } : {}) };
    }
    case "merge": {
      onlyKeys(v, ["op", "targets", "separator", "expect"], here);
      const targets = validateTargets(v.targets, here);
      const separator = optionalString(v, "separator", here);
      const expect = validateExpectMap(v.expect, here, f);
      return { op: "merge", targets, ...(separator !== undefined ? { separator } : {}), ...(expect !== undefined ? { expect } : {}) };
    }
    case "retarget": {
      onlyKeys(v, ["op", "repairs", "path_glob"], here);
      if (!Array.isArray(v.repairs)) throw effectInvalid(`${here}: \`repairs\` must be an array of { from, to }`);
      const repairs = v.repairs.map((r, j) => {
        if (!isRecord(r)) throw effectInvalid(`${here}.repairs[${j}]: must be { from, to }`);
        onlyKeys(r, ["from", "to"], `${here}.repairs[${j}]`);
        return { from: requireString(r, "from", `${here}.repairs[${j}]`), to: requireString(r, "to", `${here}.repairs[${j}]`) };
      });
      const path_glob = optionalString(v, "path_glob", here);
      return { op: "retarget", repairs, ...(path_glob !== undefined ? { path_glob } : {}) };
    }
  }
}

/** The whole list; a non-array or an empty list is a shape error too. */
export function validateEffects(v: unknown, fix?: ShapeFixContext): Effect[] {
  if (!Array.isArray(v)) throw effectInvalid("`effects` must be an array of effects");
  if (v.length === 0) throw effectInvalid("`effects` must name at least one effect");
  return v.map((e, i) => validateEffect(e, i, fix));
}

// §11.2: the `field` spellings per target kind.
export const FRONTMATTER_FIELD = /^_frontmatter\.(.+)$/;
function checkField(kind: EffectTarget["kind"], field: string, here: string, op: "set" | "unset", f?: EffectFixer): void {
  if (kind === "document") {
    if (FRONTMATTER_FIELD.test(field) || (op === "set" && field === "content")) return;
    throw effectInvalid(`${here}: a document's \`field\` is \`_frontmatter.<key>\`${op === "set" ? " or `content`" : ""} (got "${field}")`);
  }
  if (kind === "block") {
    if (field === "markdown" || field === "_attrs.checked") return;
    // (3.4, §8) `text` / `content` / `body` / `raw` on a block: the fix spells `markdown`.
    const fix = f !== undefined && BLOCK_FIELD_ALIASES.has(field) ? f.build({ ...f.written, field: "markdown" }) : undefined;
    throw effectInvalid(`${here}: a block's \`field\` is \`markdown\` or \`_attrs.checked\` (got "${field}")`, fix);
  }
  // node: the adapter's editable props (`node_not_editable` names them when unknown)
  if (field === "" || field.includes(".")) throw effectInvalid(`${here}: a node's \`field\` is one of its editable properties (got "${field}")`);
}

// ---- focus (§11.3) -------------------------------------------------------------------

/** The focus a conflict names: `{ kind, target, field? }`. */
export interface Focus {
  kind: "scalar" | "positional" | "identity";
  target: { kind: "document" | "block" | "node" | "path"; _id?: string; _path?: string };
  field?: string;
}

export function conflictingEffects(effects: [number, number], focus: Focus): MutationError {
  const what = focus.field !== undefined ? `${focus.target.kind} ${focus.target._id ?? focus.target._path} ${focus.field}` : `${focus.target.kind} ${focus.target._id ?? focus.target._path}`;
  return new MutationError("conflicting_effects", `effects ${effects[0]} and ${effects[1]} contradict each other on ${what}`, { effects, focus, retriable: false });
}

/**
 * What one effect addresses and retires, for the conflict rules. `scalar` is a
 * value write to one key; `docs`/`blocks`/`paths` are everything the effect
 * addresses (an earlier retirement of any of them is a conflict); `retires*`
 * is what later effects may no longer address.
 */
export interface FocusInfo {
  scalar?: { key: string; target: Focus["target"]; field: string; op: "set" | "unset"; value: unknown };
  /** every scalar (block, markdown) focus of a retarget */
  scalars?: { key: string; target: Focus["target"]; field: string }[];
  docs: string[];
  blocks: string[];
  paths: string[];
  retiresDocs?: string[];
  retiresBlocks?: string[];
  retiresPaths?: string[];
  /** `set document.content`: the whole document is rewritten */
  wholeDoc?: string;
}

/** The focus bookkeeping over an ordered effect list (§11.3). */
export class ConflictTracker {
  private readonly scalar = new Map<string, { index: number; op: "set" | "unset"; value: unknown; target: Focus["target"]; field: string }>();
  private readonly retiredDocs = new Map<string, number>();
  private readonly retiredBlocks = new Map<string, number>();
  private readonly retiredPaths = new Map<string, number>();
  private readonly touchedDocs = new Map<string, number>();
  readonly diagnostics: string[] = [];

  constructor(private readonly canonical: (v: unknown) => string) {}

  /** Check effect `i`; returns `false` when it is an identical duplicate to drop. Throws `conflicting_effects`. */
  check(i: number, info: FocusInfo, describe: string): boolean {
    for (const d of info.docs) {
      const by = this.retiredDocs.get(d);
      if (by !== undefined) throw conflictingEffects([by, i], { kind: "identity", target: { kind: "document", _id: d } });
    }
    for (const b of info.blocks) {
      const by = this.retiredBlocks.get(b);
      if (by !== undefined) throw conflictingEffects([by, i], { kind: "identity", target: { kind: "block", _id: b } });
    }
    for (const p of info.paths) {
      const by = this.retiredPaths.get(p);
      if (by !== undefined) throw conflictingEffects([by, i], { kind: "identity", target: { kind: "path", _path: p } });
    }
    if (info.wholeDoc !== undefined) {
      const by = this.touchedDocs.get(info.wholeDoc);
      if (by !== undefined) throw conflictingEffects([by, i], { kind: "identity", target: { kind: "document", _id: info.wholeDoc } });
    }
    if (info.scalar) {
      const prev = this.scalar.get(info.scalar.key);
      if (prev) {
        const identical = prev.op === info.scalar.op && (info.scalar.op === "unset" || this.canonical(prev.value) === this.canonical(info.scalar.value));
        if (!identical) throw conflictingEffects([prev.index, i], { kind: "scalar", target: info.scalar.target, field: info.scalar.field });
        this.diagnostics.push(`effect ${i} (${describe}) duplicates effect ${prev.index}; dropped`);
        return false;
      }
    }
    for (const s of info.scalars ?? []) {
      const prev = this.scalar.get(s.key);
      if (prev) throw conflictingEffects([prev.index, i], { kind: "scalar", target: s.target, field: s.field });
    }
    // Record.
    if (info.scalar) this.scalar.set(info.scalar.key, { index: i, op: info.scalar.op, value: info.scalar.value, target: info.scalar.target, field: info.scalar.field });
    for (const s of info.scalars ?? []) this.scalar.set(s.key, { index: i, op: "set", value: undefined, target: s.target, field: s.field });
    for (const d of info.docs) if (!this.touchedDocs.has(d)) this.touchedDocs.set(d, i);
    for (const d of info.retiresDocs ?? []) this.retiredDocs.set(d, i);
    for (const b of info.retiresBlocks ?? []) this.retiredBlocks.set(b, i);
    for (const p of info.retiresPaths ?? []) this.retiredPaths.set(p, i);
    return true;
  }
}

// ---- the lowering context ---------------------------------------------------------

/** `$new.n` symbols in allocation order (§11.4 `new_ids`). */
export class SymbolTable {
  readonly entries: { symbol: string; kind: "block" | "document" }[] = [];
  alloc(kind: "block" | "document"): string {
    const symbol = `$new.${this.entries.length}`;
    this.entries.push({ symbol, kind });
    return symbol;
  }
  kindOf(symbol: string): "block" | "document" | undefined {
    return this.entries.find((e) => e.symbol === symbol)?.kind;
  }
}

/** A `create` as the plan carries it (§11.4 `opset.creates[]`, 3.0): its document symbol, path, the
 *  composed bytes, and the index of the first kernel op planned after it (`ops.length` when none) —
 *  where `execute` adopts it again so the replay mints its block ids in the plan's order. */
export interface CreateEntry {
  symbol: string;
  path: string;
  source: string;
  before_op: number;
}

/** `preview.retarget[]` (§11.4, 3.0): what a `retarget` effect found — the `links_repair` hits and pair counts. */
export interface RetargetPreview {
  effect_index: number;
  hits: RetargetHit[];
  pairs: LinkRepairCount[];
}

export interface MoveDraft {
  id: string;
  from: string;
  to: string;
  currentRev: string | null;
  /** read at plan time for the move's own preview; `execute` re-reads */
  inbound: InboundLink[];
  retargeted: { blocks: string[]; docs: string[] } | null;
}

export interface TombstoneDraft {
  id: string;
  path: string;
  currentRev: string | null;
}

export interface LoweringContext {
  store: Store;
  repoId: string;
  docStore: DocStore;
  planner: ChangesetPlanner;
  symbols: SymbolTable;
  /** `$new.n` (a block an op minted) → the kernel placeholder `$k.ids[j]` that names it */
  blockSymbols: Map<string, string>;
  /** the created documents, in effect order (`opset.creates`) */
  creates: CreateEntry[];
  /** `preview.identity`: per `set content` document, the whole-document planner's identity consequences */
  identity: Map<string, IdentityPreview>;
  /** `preview.retarget`: per `retarget` effect, its hits and pair counts */
  retargets: RetargetPreview[];
  moves: MoveDraft[];
  tombstones: TombstoneDraft[];
  /** doc id → the file head (`set_frontmatter[].raw`), last write per document */
  heads: Map<string, string>;
  /** the kernel ops pushed, in order (`opset.ops`) */
  ops: Op[];
  /** `preconditions.blocks`: every pinned content hash, in first-pin order */
  pins: Map<string, string>;
  /** `preconditions.parents` */
  parents: { doc: string; parent: string | null; parent_children_hash: string }[];
  /** `preconditions.absent_paths` */
  absentPaths: string[];
  /** docs addressed by a move/remove document effect, in effect order (`preconditions.docs` after the loaded ones) */
  docBases: Map<string, DocBase>;
  tracker: ConflictTracker;
  canonical: (v: unknown) => string;
  /** the resolved effects kept (dropped duplicates excluded) */
  resolved: ResolvedEffect[];
  /** `preview.summary` (3.3, §11.9): one line in words per resolved effect, in order */
  summary: string[];
}

// ---- resolution --------------------------------------------------------------------

function docMissing(ref: string): MutationError {
  return new MutationError("doc_missing", `doc ${ref} not found`, { doc: ref });
}

/** Resolve a document target: an existing document's `{ _id, _path }`, or a `$new.n` document this plan creates. */
export function resolveDocumentTarget(ctx: LoweringContext, t: Extract<EffectTarget, { kind: "document" }>): Extract<ResolvedTarget, { kind: "document" }> {
  if (t._id !== undefined && isNewSymbol(t._id)) {
    const created = ctx.creates.find((c) => c.symbol === t._id);
    if (!created) throw symbolMissing(ctx, t._id, "document");
    if (t._path !== undefined && canonicalDocPath(t._path) !== created.path) throw effectInvalid(`\`_id\` ${JSON.stringify(t._id)} and \`_path\` ${JSON.stringify(t._path)} name different documents`);
    return { kind: "document", _id: t._id, _path: created.path };
  }
  return findDocumentTarget(ctx.store, ctx.repoId, t);
}

/** An existing document's `{ _id, _path }` for a literal document target (`doc_missing`; `filter_invalid` when `_id` and `_path` disagree). */
export function findDocumentTarget(store: Store, repoId: string, t: Extract<EffectTarget, { kind: "document" }>): Extract<ResolvedTarget, { kind: "document" }> {
  const byId = t._id !== undefined ? findDoc(store, { docId: t._id }) : null;
  if (t._id !== undefined && (!byId || byId.repoId !== repoId)) throw docMissing(t._id);
  const byPath = t._path !== undefined ? findDoc(store, { repoId, path: t._path }) : null;
  if (t._path !== undefined && !byPath) throw docMissing(t._path);
  if (byId && byPath && byId.docId !== byPath.docId) throw effectInvalid(`\`_id\` ${JSON.stringify(t._id)} and \`_path\` ${JSON.stringify(t._path)} name different documents`);
  const info = (byId ?? byPath)!;
  return { kind: "document", _id: info.docId, _path: info.path };
}

/** A bare `$new.n` target (3.2): the kind the symbol table recorded, checked against the slot's admitted kinds. */
function resolveSymbolTarget(ctx: LoweringContext, symbol: string, kinds: readonly EffectTarget["kind"][], here: string): Exclude<EffectTarget, { kind: "symbol" }> {
  const kind = ctx.symbols.kindOf(symbol);
  if (kind === undefined) throw new MutationError("target_missing", `${symbol} is not created by an earlier effect`, { symbol });
  if (!kinds.includes(kind)) throw effectInvalid(`${here}: \`kind\` must be one of ${kinds.join(", ")} (got "${kind}")`);
  return { kind, _id: symbol };
}

function symbolMissing(ctx: LoweringContext, symbol: string, wanted: "block" | "document"): MutationError {
  const kind = ctx.symbols.kindOf(symbol);
  if (kind === undefined) return new MutationError("target_missing", `${symbol} is not created by an earlier effect`, { symbol });
  return new MutationError("target_missing", `${symbol} names a ${kind}, not a ${wanted}`, { symbol });
}

/** A block id as the kernel must see it: a `$new.n` an op minted becomes the placeholder of that op;
 *  a `$new.n` of a created document's tree (3.0) stays the symbol — it IS the tree's id at plan
 *  time, and `execute` aliases it to the id its replay mints (§11.7). */
function kernelBlockId(ctx: LoweringContext, id: string): string {
  if (!isNewSymbol(id)) return id;
  const placeholder = ctx.blockSymbols.get(id);
  if (placeholder !== undefined) return placeholder;
  if (locateLoaded(ctx, id)) return id;
  throw symbolMissing(ctx, id, "block");
}

function kernelAt(ctx: LoweringContext, at: EffectAt): At {
  if (at === "start" || at === "end") return at;
  if ("before" in at) return { before: kernelBlockId(ctx, at.before) };
  return { after: kernelBlockId(ctx, at.after) };
}

/** A block in the planner's trees (a `$new.n` is only there) — never loads a document. */
function locateLoaded(ctx: LoweringContext, id: string): { docId: string; block: MutBlock } | null {
  const f = ctx.planner.locateLoaded(id);
  return f ? { docId: f.docId, block: f.block } : null;
}

/** The live row of a block: its document and raw hash; `$new.n` from the tree. */
function blockInfo(ctx: LoweringContext, id: string): { docId: string; hash: string; block: MutBlock | null } {
  const inTree = locateLoaded(ctx, id);
  if (inTree) return { docId: inTree.docId, hash: rawHashHex(inTree.block.raw), block: inTree.block };
  if (isNewSymbol(id)) throw symbolMissing(ctx, id, "block");
  const row = ctx.store.db
    .prepare("SELECT doc_id, lower(hex(raw_hash)) h FROM blocks WHERE block_id = ? AND deleted_commit IS NULL")
    .get(id) as { doc_id: string; h: string } | undefined;
  if (!row) throw new MutationError("block_missing", `block ${id} not found`, { block: id });
  return { docId: row.doc_id, hash: row.h, block: null };
}

// ---- the summary (§11.9, 3.3) ---------------------------------------------------------
//
// Channel 3 of the teaching surfaces: the plan is a worked example of itself.
// One line in words per resolved effect — `preview.summary`, which the Receipt
// repeats as its `summary` and the CLI prints under the commit confirmation.
// Deterministic and byte-identical across engines (the wording table of §11.9):
// a document by its rooted path, a heading by its text in quotes, any other
// block by its type and id, counts with their nouns pluralized by an `s`.

/** `1 block` / `2 blocks` (an `s` on every noun of the table). */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The rooted path of a document the plan addresses — a created document's from its `create`. */
function docPathOf(ctx: LoweringContext, docId: string): string {
  if (isNewSymbol(docId)) {
    const created = ctx.creates.find((c) => c.symbol === docId);
    if (created) return referencePath(created.path);
  }
  const info = findDoc(ctx.store, { docId });
  return referencePath(info?.path ?? docId);
}

/** A block's type and visible text: the live row when it has one, else the planner's tree (a `$new.k`). */
function blockDescriptor(ctx: LoweringContext, id: string): { type: string; text: string } | null {
  if (!isNewSymbol(id)) {
    const row = ctx.store.db.prepare("SELECT type, text FROM blocks WHERE block_id = ? AND deleted_commit IS NULL").get(id) as { type: string; text: string } | undefined;
    if (row) return { type: row.type, text: row.text };
  }
  const inTree = locateLoaded(ctx, id);
  if (!inTree) return null;
  return { type: inTree.block.type, text: normalizeVisibleText(inTree.block.raw, inTree.block.type) };
}

/** The name of a block in a summary line: `heading "Text"` for a heading, else `<type> <id>` (`paragraph b_12`, `task b_9`). */
function blockName(ctx: LoweringContext, id: string): string {
  const d = blockDescriptor(ctx, id);
  if (d === null) return `block ${id}`;
  return d.type === "heading" ? `heading ${ctx.canonical(d.text)}` : `${d.type} ${id}`;
}

/** A section by its heading's text: `section "Risks"`. */
function sectionName(ctx: LoweringContext, headingId: string): string {
  const d = blockDescriptor(ctx, headingId);
  return `section ${ctx.canonical(d?.text ?? headingId)}`;
}

/**
 * The placement half of an `insert` / `move blocks` line: `<verb> the end|start
 * of <container> [in <path>]` — the container a document (its path; no `in`), a
 * section (`section "Risks"`) or a block (its name) — or `before|after <block>
 * in <path>`. `verb` is `at` for an insert, `to` for a move.
 */
function placeWords(ctx: LoweringContext, into: ResolvedTarget, at: EffectAt, verb: "at" | "to"): string {
  const path = docPathOf(ctx, targetDoc(ctx, into));
  if (at !== "start" && at !== "end") {
    const anchor = "before" in at ? at.before : at.after;
    return `${"before" in at ? "before" : "after"} ${blockName(ctx, anchor)} in ${path}`;
  }
  const edge = `${verb} the ${at}`;
  switch (into.kind) {
    case "document":
      return `${edge} of ${path}`;
    case "section":
      return `${edge} of ${sectionName(ctx, into.heading_id)} in ${path}`;
    case "block":
      return `${edge} of ${blockName(ctx, into._id)} in ${path}`;
    case "node":
      return `${edge} of node ${into._id} in ${path}`;
  }
}

/** The document of a block list's first block (a kernel `remove`/`merge` names blocks of one document). */
function docOfBlocks(ctx: LoweringContext, ids: string[]): string {
  return docPathOf(ctx, blockInfo(ctx, ids[0]!).docId);
}

/** Every descendant id of a block: the planner's tree when loaded, else the store's live rows. */
function descendantsOf(ctx: LoweringContext, id: string): string[] {
  const inTree = locateLoaded(ctx, id);
  if (inTree) {
    const out: string[] = [];
    const walk = (b: MutBlock): void => {
      for (const c of b.children) {
        out.push(c.id);
        walk(c);
      }
    };
    walk(inTree.block);
    return out;
  }
  if (isNewSymbol(id)) return [];
  const rows = ctx.store.db
    .prepare(
      `WITH RECURSIVE sub(block_id) AS (
         SELECT block_id FROM blocks WHERE parent_block = ? AND deleted_commit IS NULL
         UNION ALL
         SELECT b.block_id FROM blocks b JOIN sub ON b.parent_block = sub.block_id WHERE b.deleted_commit IS NULL
       ) SELECT block_id FROM sub`,
    )
    .all(id) as { block_id: string }[];
  return rows.map((r) => r.block_id);
}

/** The document a placement target lives in (loading nothing; `parent_missing` for an unknown heading/block). */
function targetDoc(ctx: LoweringContext, t: ResolvedTarget): string {
  switch (t.kind) {
    case "document":
      return t._id;
    case "section": {
      const inTree = locateLoaded(ctx, t.heading_id);
      if (inTree) return inTree.docId;
      const row = ctx.store.db.prepare("SELECT doc_id FROM blocks WHERE block_id = ? AND deleted_commit IS NULL").get(t.heading_id) as { doc_id: string } | undefined;
      if (!row) throw new MutationError("parent_missing", `parent ${t.heading_id} not found`);
      return row.doc_id;
    }
    case "block": {
      const inTree = locateLoaded(ctx, t._id);
      if (inTree) return inTree.docId;
      if (isNewSymbol(t._id)) throw symbolMissing(ctx, t._id, "block");
      const row = ctx.store.db.prepare("SELECT doc_id FROM blocks WHERE block_id = ? AND deleted_commit IS NULL").get(t._id) as { doc_id: string } | undefined;
      if (!row) throw new MutationError("parent_missing", `parent ${t._id} not found`);
      return row.doc_id;
    }
    case "node":
      return nodeBlock(ctx, t._id).docId;
  }
}

function nodeBlock(ctx: LoweringContext, nodeId: string): { docId: string; blockId: string } {
  const row = ctx.store.db.prepare("SELECT doc_id, block_id FROM nodes WHERE node_id = ?").get(nodeId) as { doc_id: string; block_id: string | null } | undefined;
  if (!row) throw new MutationError("block_missing", `node ${nodeId} not found`, {});
  if (!row.block_id) throw new MutationError("node_not_editable", `node ${nodeId} is not anchored to a block`, {});
  return { docId: row.doc_id, blockId: row.block_id };
}

function placement(ctx: LoweringContext, into: ResolvedTarget, at: EffectAt): To {
  const kernel = kernelAt(ctx, at);
  switch (into.kind) {
    case "document":
      return { parent: { doc: true }, at: kernel };
    case "section":
      return { parent: { heading: kernelBlockId(ctx, into.heading_id), scope: "section" }, at: kernel };
    case "block":
      return { parent: kernelBlockId(ctx, into._id), at: kernel };
    case "node":
      throw effectInvalid("a node is not a placement target");
  }
}

/** `expect.revision` against the document's current revision (§11.2): a mismatch is `stale_plan`. */
function checkRevision(ctx: LoweringContext, docId: string, expect: EffectExpect | undefined): void {
  if (expect?.revision === undefined) return;
  if (isNewSymbol(docId)) throw effectInvalid(`expect.revision cannot name a document this plan creates (${docId})`);
  const base = readDocBase(ctx.store.db, docId);
  if (!base) throw docMissing(docId);
  if (base.currentRev !== expect.revision) {
    throw new MutationError("stale_plan", `document ${docId} is at revision ${base.currentRev ?? "null"}, not ${expect.revision}; re-plan`, {
      doc: docId,
      expected_revision: expect.revision,
      current: { revision: base.currentRev, _hash: base.fileHash },
      retriable: true,
    });
  }
}

/** Pin a block's content hash: the caller's `expect.content_hash` when given, else the live row's (the sugar tools' rule). */
function pin(ctx: LoweringContext, id: string, given: string | undefined): string {
  const hash = given ?? blockInfo(ctx, id).hash;
  if (!isNewSymbol(id) && !ctx.pins.has(id)) ctx.pins.set(id, hash);
  return hash;
}

function pushOp(ctx: LoweringContext, op: Op): void {
  ctx.ops.push(op);
  const before = ctx.planner.results.length;
  ctx.planner.push(op);
  // Any `$new.n` this op minted is referenceable through the op's placeholder.
  const result = ctx.planner.results[before]!;
  result.ids.forEach((id, j) => {
    if (isNewSymbol(id) && !ctx.blockSymbols.has(id)) ctx.blockSymbols.set(id, `$${before}.ids[${j}]`);
  });
}

function kernelExpect(e: EffectExpect | undefined, contentHash?: string): Expect | undefined {
  const out: Expect = {};
  if (contentHash !== undefined) out.content_hash = contentHash;
  if (e?.parent_children_hash !== undefined) out.parent_children_hash = e.parent_children_hash;
  return Object.keys(out).length > 0 ? out : undefined;
}

function recordParentPin(ctx: LoweringContext, doc: string, into: ResolvedTarget, expect: EffectExpect | undefined): void {
  if (expect?.parent_children_hash === undefined) return;
  const parent = into.kind === "block" ? into._id : null;
  ctx.parents.push({ doc, parent, parent_children_hash: expect.parent_children_hash });
}

// ---- lowering (§11.3, the table) -----------------------------------------------------

function describe(e: ResolvedEffect): string {
  switch (e.op) {
    case "create": return `create ${e.path}`;
    case "insert": return `insert into ${targetName(e.into)}`;
    case "set": return `set ${e.field} on ${targetName(e.target)}`;
    case "unset": return `unset ${e.field} on ${targetName(e.target)}`;
    case "move": return "targets" in e ? `move ${e.targets.map(targetName).join(",")}` : `move ${targetName(e.target)} -> ${e.to}`;
    case "remove": return "targets" in e ? `remove ${e.targets.map(targetName).join(",")}` : `remove ${targetName(e.target)}`;
    case "split": return `split ${targetName(e.target)}`;
    case "merge": return `merge ${e.targets.map(targetName).join(",")}`;
    case "retarget": return `retarget ${e.repairs.map((r) => `${r.from}->${r.to}`).join(",")}`;
  }
}
function targetName(t: ResolvedTarget): string {
  return t.kind === "section" ? `section ${t.heading_id}` : `${t.kind} ${t._id}`;
}

/** The target kinds each slot admits (§11.1); `validateTarget` checks a literal, `resolveEffect` a bare `$new.n`. */
const PLACEMENT_KINDS: readonly EffectTarget["kind"][] = ["document", "section", "block"];
const DOCUMENT_KIND: readonly EffectTarget["kind"][] = ["document"];
const BLOCK_KIND: readonly EffectTarget["kind"][] = ["block"];
const SET_KINDS: readonly EffectTarget["kind"][] = ["document", "block", "node"];

/** Resolve one validated effect's targets (§11.4): documents to `{ _id, _path }`, defaults made explicit; `i` names the effect in messages. */
export function resolveEffect(ctx: LoweringContext, e: Effect, i = 0): ResolvedEffect {
  const here = `effects[${i}]`;
  const target = (t: EffectTarget, kinds: readonly EffectTarget["kind"][], member: string): ResolvedTarget => {
    const literal = t.kind === "symbol" ? resolveSymbolTarget(ctx, t._id, kinds, `${here}.${member}`) : t;
    return literal.kind === "document" ? resolveDocumentTarget(ctx, literal) : literal;
  };
  const targets = (list: EffectTarget[]): ResolvedTarget[] => list.map((t, k) => target(t, BLOCK_KIND, `targets[${k}]`));
  switch (e.op) {
    case "create":
      return { op: "create", path: canonicalDocPath(e.path), markdown: e.markdown, ...(e.frontmatter !== undefined ? { frontmatter: e.frontmatter } : {}) };
    case "insert":
      return { op: "insert", into: target(e.into, PLACEMENT_KINDS, "into"), at: e.at ?? "end", markdown: e.markdown, ...(e.expect !== undefined ? { expect: e.expect } : {}) };
    case "set":
    case "unset": {
      const t = target(e.target, e.op === "set" ? SET_KINDS : DOCUMENT_KIND, "target");
      // A bare `$new.n` deferred its `field` check (§11.2) to here, where its kind is known.
      if (e.target.kind === "symbol") checkField(t.kind, e.field, here, e.op);
      if (e.op === "set") return { op: "set", target: t, field: e.field, value: e.value, ...(e.expect !== undefined ? { expect: e.expect } : {}) };
      return { op: "unset", target: t, field: e.field, ...(e.expect !== undefined ? { expect: e.expect } : {}) };
    }
    case "move":
      if ("targets" in e) return { op: "move", targets: targets(e.targets), into: target(e.into, PLACEMENT_KINDS, "into"), at: e.at ?? "end", ...(e.expect !== undefined ? { expect: e.expect } : {}) };
      return { op: "move", target: target(e.target, DOCUMENT_KIND, "target"), to: canonicalDocPath(e.to), retarget_inbound: e.retarget_inbound !== false };
    case "remove":
      if ("targets" in e) return { op: "remove", targets: targets(e.targets), ...(e.expect !== undefined ? { expect: e.expect } : {}) };
      return { op: "remove", target: target(e.target, DOCUMENT_KIND, "target") };
    case "split":
      return { op: "split", target: target(e.target, BLOCK_KIND, "target"), at: [...e.at], ...(e.expect !== undefined ? { expect: e.expect } : {}) };
    case "merge":
      return { op: "merge", targets: targets(e.targets), separator: e.separator ?? " ", ...(e.expect !== undefined ? { expect: e.expect } : {}) };
    case "retarget":
      return { op: "retarget", repairs: e.repairs.map((r) => ({ from: r.from, to: r.to })), ...(e.path_glob !== undefined ? { path_glob: e.path_glob } : {}) };
  }
}

function docTarget(t: ResolvedTarget): Extract<ResolvedTarget, { kind: "document" }> {
  if (t.kind !== "document") throw effectInvalid(`expected a document target, got ${t.kind}`);
  return t;
}
function blockTarget(t: ResolvedTarget): Extract<ResolvedTarget, { kind: "block" }> {
  if (t.kind !== "block") throw effectInvalid(`expected a block target, got ${t.kind}`);
  return t;
}
function nodeTarget(t: ResolvedTarget): Extract<ResolvedTarget, { kind: "node" }> {
  if (t.kind !== "node") throw effectInvalid(`expected a node target, got ${t.kind}`);
  return t;
}

/**
 * The frontmatter effects are Markdown's (spec/properties §3.4, 1.2; spec/surface
 * Decisions 2026-10-17): a `yaml`/`json` document's "frontmatter" IS its whole
 * top-level mapping, and the entry patch below would fence it with `---` lines —
 * a second YAML document, or invalid JSON. Until the effect learns those formats
 * the request is refused outright — `type_mismatch`, the target's kind does not
 * admit the op — and the mapping is edited with `set content` (the whole file).
 */
function requireMarkdownForFrontmatter(ctx: LoweringContext, docId: string, field: string): void {
  const d = ctx.planner.ensureDoc(docId);
  if (d.format === "markdown") return;
  throw frontmatterNotMarkdown(docPathOf(ctx, docId), d.format, field, isNewSymbol(docId) ? null : docId);
}

function frontmatterNotMarkdown(path: string, format: string, field: string, docId: string | null): MutationError {
  return new MutationError(
    "type_mismatch",
    `frontmatter effects apply to markdown documents; ${referencePath(path)} is a ${format} document — its top-level mapping is edited with \`set content\` (the whole file) until frontmatter effects learn yaml and json`,
    { ...(docId !== null ? { doc: docId } : {}), _path: referencePath(path), _format: format, field },
  );
}

/**
 * spec/mutate §11.3 `set`/`unset _frontmatter.<key>` (3.6, "Frontmatter
 * entries"): the frontmatter is edited BY ENTRY. The document's head is cut
 * into its parts (`splitFrontmatterRaw`, the §11.3 split rule): a `set`
 * replaces the key's part — the lead lines (a comment documenting the key)
 * kept, the entry's own lines re-rendered as `stringify({ key: value })` in
 * the fence's line endings — removes any duplicate of the key, or inserts the
 * new key's part after the last entry (before the trailing comments and the
 * closing fence); an `unset` removes every part of the key. Every other part
 * is byte-identical afterwards — a flow list, a quoted string, a comment the
 * author wrote survive a change to a different key. When nothing but the
 * fences would remain, the frontmatter goes and the separator's first line
 * ending with it (the §6 `set_meta` rule: a body that followed a blank line
 * keeps it as leading trivia). A document WITHOUT frontmatter (or one whose
 * head the fence rule does not recognise) still composes as `docs_set_meta`
 * did through 3.5 — `composeFile(body, merged)` — which for a new fence is
 * the same bytes a one-key part would give.
 */
function patchFrontmatterKey(ctx: LoweringContext, docId: string, key: string, set: { value: unknown } | null): void {
  const d = ctx.planner.ensureDoc(docId);
  const fence = d.frontmatterRaw === null ? null : splitFrontmatterTrivia(d.frontmatterRaw);
  if (fence === null) {
    const { frontmatter, body } = splitFrontmatter(renderDoc(d));
    const merged: Record<string, unknown> = { ...frontmatter };
    if (set) merged[key] = set.value;
    else delete merged[key];
    patchFrontmatter(ctx, docId, merged, body);
    return;
  }
  let parts = splitFrontmatterRaw(fence.raw);
  const eol = lineEndingOf(parts[0]!.bytes) || "\n";
  if (set) {
    let rendered = stringifyYaml({ [key]: set.value });
    if (!rendered.endsWith("\n")) rendered += "\n";
    if (eol !== "\n") rendered = rendered.split("\n").join(eol);
    const at = parts.findIndex((p) => p.key === key);
    if (at >= 0) {
      parts[at] = { key, bytes: leadOf(parts[at]!) + rendered };
      parts = parts.filter((p, i) => i === at || p.key !== key);
    } else {
      let last = -1;
      parts.forEach((p, i) => {
        if (p.key !== null) last = i;
      });
      parts.splice(last >= 0 ? last + 1 : parts.length - 1, 0, { key, bytes: rendered });
    }
  } else {
    parts = parts.filter((p) => p.key !== key);
  }
  const head = parts.length === 2 ? fence.trivia.replace(/^\r?\n/, "") : joinFrontmatterParts(parts) + fence.trivia;
  ctx.planner.setHead(docId, head);
  ctx.heads.set(docId, head);
}

/**
 * Patch a document WITHOUT frontmatter: compose the whole file as
 * `docs_set_meta` did (`composeFile(body, merged)`, §6), then set the file
 * head so the known-id ingest renders exactly those bytes — the body blocks
 * keep their ids and bytes (a file without a trailing newline gains one on its
 * last block's trivia, as `composeFile` would add it).
 */
function patchFrontmatter(ctx: LoweringContext, docId: string, merged: Record<string, unknown>, body: string): void {
  const d = ctx.planner.ensureDoc(docId);
  const after = composeFile(body, merged);
  let blocks = d.children.map((b) => renderBlockExact(d, b)).join("");
  if (!after.endsWith(blocks)) {
    const last = d.children[d.children.length - 1];
    if (last && after.endsWith(blocks + "\n")) {
      last.trivia += "\n";
      blocks += "\n";
    } else {
      throw new MutationError("plan_not_convergent", `the frontmatter patch of ${docId} does not preserve the body bytes`, { doc: docId });
    }
  }
  const head = after.slice(0, after.length - blocks.length);
  ctx.planner.setHead(docId, head);
  ctx.heads.set(docId, head);
}

// A top-level block as `renderDoc` emits it (its subtree may be dirty from an earlier op).
function renderBlockExact(d: MutDoc, b: MutBlock): string {
  const solo: MutDoc = { ...d, leadingTrivia: "", frontmatterRaw: null, children: [b] };
  return renderDoc(solo);
}

/** Shift a kernel op's `$n.ids[i]` placeholders by `offset` (an opset planned alone, spliced into a longer op list). */
export function shiftPlaceholders(op: Op, offset: number): Op {
  const s = (v: string): string => {
    const m = /^\$(\d+)\.ids\[(\d+)\]$/.exec(v);
    return m ? `$${Number(m[1]) + offset}.ids[${m[2]}]` : v;
  };
  const to = (t: To): To => ({
    parent: typeof t.parent === "string" ? s(t.parent) : t.parent,
    at: typeof t.at === "string" ? t.at : "before" in t.at ? { before: s(t.at.before) } : { after: s(t.at.after) },
  });
  switch (op.op) {
    case "insert": return { ...op, to: to(op.to) };
    case "update": return { ...op, block: s(op.block) };
    case "move": return { ...op, blocks: op.blocks.map(s), to: to(op.to) };
    case "remove": return { ...op, blocks: op.blocks.map(s) };
    case "split": return { ...op, block: s(op.block) };
    case "merge": return { ...op, blocks: op.blocks.map(s) };
  }
}

/**
 * Lower effect `i` (already validated): resolve its targets, classify its
 * focus (throwing `conflicting_effects`, or dropping an identical duplicate
 * with a diagnostic), then push its kernel ops / document drafts. Returns the
 * resolved effect, or null when it was dropped.
 */
export function lowerEffect(ctx: LoweringContext, i: number, effect: Effect): ResolvedEffect | null {
  const e = resolveEffect(ctx, effect, i);
  const info = focusOf(ctx, e);
  if (!ctx.tracker.check(i, info, describe(e))) return null;
  ctx.resolved.push(e);
  applyLowering(ctx, i, e);
  return e;
}

// The addressed/retired sets and the scalar key of an effect (§11.3 table).
function focusOf(ctx: LoweringContext, e: ResolvedEffect): FocusInfo {
  const blocksOf = (ids: string[]): { docs: string[]; blocks: string[] } => {
    const docs = new Set<string>();
    for (const id of ids) docs.add(blockInfo(ctx, id).docId);
    return { docs: [...docs], blocks: ids };
  };
  switch (e.op) {
    case "create":
      return { docs: [], blocks: [], paths: [e.path] };
    case "insert": {
      const doc = targetDoc(ctx, e.into);
      const blocks = [...(e.into.kind === "block" ? [e.into._id] : e.into.kind === "section" ? [e.into.heading_id] : []), ...anchorIds(e.at)];
      return { docs: [doc], blocks, paths: [] };
    }
    case "set":
    case "unset": {
      if (e.target.kind === "document") {
        const field = e.field === "content" ? "content" : e.field;
        return {
          scalar: { key: `document:${e.target._id}:${field}`, target: { kind: "document", _id: e.target._id }, field, op: e.op, value: e.op === "set" ? e.value : undefined },
          docs: [e.target._id], blocks: [], paths: [],
          ...(field === "content" ? { wholeDoc: e.target._id, retiresDocs: [e.target._id], retiresBlocks: allBlocksOf(ctx, e.target._id) } : {}),
        };
      }
      if (e.target.kind === "block") {
        const { docId } = blockInfo(ctx, e.target._id);
        return {
          scalar: { key: `block:${e.target._id}:${e.field}`, target: { kind: "block", _id: e.target._id }, field: e.field, op: e.op, value: e.op === "set" ? e.value : undefined },
          docs: [docId], blocks: [e.target._id], paths: [],
          ...(e.field === "markdown" ? { retiresBlocks: descendantsOf(ctx, e.target._id) } : {}),
        };
      }
      const node = nodeTarget(e.target);
      const { docId, blockId } = nodeBlock(ctx, node._id);
      return {
        scalar: { key: `node:${node._id}:${e.field}`, target: { kind: "node", _id: node._id }, field: e.field, op: e.op, value: e.op === "set" ? e.value : undefined },
        docs: [docId], blocks: [blockId], paths: [],
      };
    }
    case "move": {
      if ("targets" in e) {
        const ids = e.targets.map((t) => blockTarget(t)._id);
        const { docs } = blocksOf(ids);
        const dst = targetDoc(ctx, e.into);
        const blocks = [...ids, ...(e.into.kind === "block" ? [e.into._id] : e.into.kind === "section" ? [e.into.heading_id] : []), ...anchorIds(e.at)];
        return { docs: [...new Set([...docs, dst])], blocks, paths: [] };
      }
      const t = docTarget(e.target);
      return {
        scalar: { key: `document:${t._id}:path`, target: { kind: "document", _id: t._id }, field: "_path", op: "set", value: e.to },
        docs: [t._id], blocks: [], paths: [e.to], retiresPaths: [t._path],
      };
    }
    case "remove": {
      if ("targets" in e) {
        const ids = e.targets.map((t) => blockTarget(t)._id);
        const { docs } = blocksOf(ids);
        return { docs, blocks: ids, paths: [], retiresBlocks: ids.flatMap((id) => [id, ...descendantsOf(ctx, id)]) };
      }
      const t = docTarget(e.target);
      return { docs: [t._id], blocks: [], paths: [], retiresDocs: [t._id], retiresBlocks: allBlocksOf(ctx, t._id) };
    }
    case "split": {
      const id = blockTarget(e.target)._id;
      return { ...blocksOf([id]), paths: [] };
    }
    case "merge": {
      const ids = e.targets.map((t) => blockTarget(t)._id);
      return { ...blocksOf(ids), paths: [], retiresBlocks: ids.slice(1).flatMap((id) => [id, ...descendantsOf(ctx, id)]) };
    }
    case "retarget": {
      const plan = linksRepair(ctx.store, ctx.repoId, e.repairs, e.path_glob !== undefined ? { pathGlob: e.path_glob } : {});
      const ids = plan.ops.map((o) => (o as { block: string }).block);
      return {
        scalars: ids.map((id) => ({ key: `block:${id}:markdown`, target: { kind: "block", _id: id }, field: "markdown" })),
        ...blocksOf(ids), paths: [],
      };
    }
  }
}

function anchorIds(at: EffectAt): string[] {
  if (at === "start" || at === "end") return [];
  return ["before" in at ? at.before : at.after];
}

function allBlocksOf(ctx: LoweringContext, docId: string): string[] {
  if (isNewSymbol(docId)) return [];
  return (ctx.store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = ? AND deleted_commit IS NULL").all(docId) as { block_id: string }[]).map((r) => r.block_id);
}

// The lowering table (§11.3), one resolved effect → kernel ops / document entries. `i` is the effect's index.
function applyLowering(ctx: LoweringContext, i: number, e: ResolvedEffect): void {
  switch (e.op) {
    case "create": {
      if (findDoc(ctx.store, { repoId: ctx.repoId, path: e.path })) throw new MutationError("path_taken", `document already exists at ${e.path}`, { path: e.path });
      if (ctx.absentPaths.includes(e.path)) throw new MutationError("path_taken", `an earlier effect already creates or moves a document to ${e.path}`, { path: e.path });
      if (ctx.docStore.exists(e.path)) throw new MutationError("path_taken", `file already exists on disk at ${e.path}`, { path: e.path });
      // 3.0: the document symbol, then its tree parsed under the symbolic minter
      // — its blocks are the next `$new.k` in pre-order — and adopted as a loaded
      // document, so every later effect addresses it and its blocks like any other.
      const symbol = ctx.symbols.alloc("document");
      if (e.frontmatter && Object.keys(e.frontmatter).length > 0) {
        const format = adapterForPath(e.path)?.format ?? "markdown";
        if (format !== "markdown") throw frontmatterNotMarkdown(e.path, format, "frontmatter", null);
      }
      const source = composeFile(e.markdown, e.frontmatter);
      const tree = parseNewDoc(symbol, e.path, source);
      ctx.planner.adoptNew(symbol, tree);
      ctx.creates.push({ symbol, path: e.path, source, before_op: ctx.ops.length });
      ctx.absentPaths.push(e.path);
      ctx.summary.push(`create ${referencePath(e.path)} (${plural(tree.children.length, "block")})`);
      return;
    }
    case "insert": {
      const doc = targetDoc(ctx, e.into);
      checkRevision(ctx, doc, e.expect);
      recordParentPin(ctx, doc, e.into, e.expect);
      const to = placement(ctx, e.into, e.at);
      const expect = kernelExpect(e.expect);
      const where = placeWords(ctx, e.into, e.at, "at");
      pushOp(ctx, { op: "insert", ...(e.into.kind === "document" ? { doc } : {}), to, markdown: e.markdown, ...(expect !== undefined ? { expect } : {}) });
      ctx.summary.push(`insert ${plural(ctx.planner.results[ctx.planner.results.length - 1]!.ids.length, "block")} ${where}`);
      return;
    }
    case "set":
    case "unset": {
      if (e.target.kind === "document") {
        const docId = e.target._id;
        checkRevision(ctx, docId, e.expect);
        if (e.field === "content") {
          if (e.op !== "set" || typeof e.value !== "string") throw effectInvalid("`content` takes a string value: the complete proposed document");
          if (isNewSymbol(docId)) throw new MutationError("target_missing", `${docId} is a document this plan creates; its content is the create's markdown`, { symbol: docId });
          lowerContent(ctx, docId, e.value);
          ctx.summary.push(`set content of ${docPathOf(ctx, docId)}`);
          return;
        }
        // `_frontmatter.<key>` — on a created document too (3.0): its tree is loaded, the patch is a head like any other.
        const key = FRONTMATTER_FIELD.exec(e.field)![1]!;
        requireMarkdownForFrontmatter(ctx, docId, e.field);
        patchFrontmatterKey(ctx, docId, key, e.op === "set" ? { value: e.value } : null);
        ctx.summary.push(e.op === "set" ? `set ${e.field} = ${ctx.canonical(e.value)} in ${docPathOf(ctx, docId)}` : `unset ${e.field} in ${docPathOf(ctx, docId)}`);
        return;
      }
      if (e.op !== "set") throw effectInvalid("`unset` takes a document target");
      if (e.target.kind === "block") {
        const id = e.target._id;
        const { docId } = blockInfo(ctx, id);
        checkRevision(ctx, docId, e.expect);
        const hash = pin(ctx, id, e.expect?.content_hash);
        const name = blockName(ctx, id);
        if (e.field === "markdown") {
          if (typeof e.value !== "string") throw effectInvalid("`markdown` takes a string value");
          pushOp(ctx, { op: "update", block: kernelBlockId(ctx, id), markdown: e.value, expect: kernelExpect(e.expect, hash)! });
          ctx.summary.push(`set markdown of ${name} in ${docPathOf(ctx, docId)}`);
        } else {
          if (typeof e.value !== "boolean") throw effectInvalid("`_attrs.checked` takes a boolean value");
          pushOp(ctx, { op: "update", block: kernelBlockId(ctx, id), attrs: { checked: e.value }, expect: kernelExpect(e.expect, hash)! });
          ctx.summary.push(`${e.value ? "check" : "uncheck"} ${name} in ${docPathOf(ctx, docId)}`);
        }
        return;
      }
      // node: the adapter's editor → one update (macros.ts nodeSet)
      const node = nodeTarget(e.target);
      const { docId, blockId } = nodeBlock(ctx, node._id);
      checkRevision(ctx, docId, e.expect);
      const ops = nodeSet(ctx.store, node._id, e.field, typeof e.value === "string" ? e.value : ctx.canonical(e.value));
      for (const op of ops) {
        const u = op as Extract<Op, { op: "update" }>;
        const hash = pin(ctx, blockId, e.expect?.content_hash ?? u.expect?.content_hash);
        pushOp(ctx, { ...u, expect: { ...(u.expect ?? {}), content_hash: hash } });
      }
      ctx.summary.push(`set ${e.field} = ${ctx.canonical(e.value)} on node ${node._id} in ${docPathOf(ctx, docId)}`);
      return;
    }
    case "move": {
      if ("targets" in e) {
        const ids = e.targets.map((t) => blockTarget(t)._id);
        const dst = targetDoc(ctx, e.into);
        checkRevision(ctx, dst, e.expect);
        recordParentPin(ctx, dst, e.into, e.expect);
        const to = placement(ctx, e.into, e.at);
        const expect = kernelExpect(e.expect);
        const what = ids.length === 1 ? blockName(ctx, ids[0]!) : plural(ids.length, "block");
        const where = placeWords(ctx, e.into, e.at, "to");
        // `doc` names the destination when `into` is a document (§2.3, 3.0): a
        // top-level start/end would otherwise mean the SOURCE document's.
        pushOp(ctx, { op: "move", blocks: ids.map((id) => kernelBlockId(ctx, id)), to, ...(e.into.kind === "document" ? { doc: dst } : {}), ...(expect !== undefined ? { expect } : {}) });
        ctx.summary.push(`move ${what} ${where}`);
        return;
      }
      const t = docTarget(e.target);
      if (isNewSymbol(t._id)) throw new MutationError("target_missing", `${t._id} is a document this plan creates; it cannot be moved in the same plan`, { symbol: t._id });
      const base = readDocBase(ctx.store.db, t._id);
      if (!base) throw docMissing(t._id);
      if (findDoc(ctx.store, { repoId: ctx.repoId, path: e.to })) throw new MutationError("path_taken", `a document already exists at ${e.to}`, { path: e.to });
      if (ctx.absentPaths.includes(e.to)) throw new MutationError("path_taken", `an earlier effect already creates or moves a document to ${e.to}`, { path: e.to });
      if (ctx.docStore.exists(e.to)) throw new MutationError("path_taken", `file already exists on disk at ${e.to}`, { path: e.to });
      ctx.absentPaths.push(e.to);
      if (!ctx.docBases.has(t._id)) ctx.docBases.set(t._id, base);
      const inbound = inboundLinksTo(ctx.store, ctx.repoId, t._id, t._path);
      let retargeted: MoveDraft["retargeted"] = null;
      let links = "";
      if (e.retarget_inbound && inbound.length > 0) {
        const plan = planInboundRetarget(ctx.store, t._id, t._path, e.to, inbound);
        for (const op of plan.ops) {
          const u = op as Extract<Op, { op: "update" }>;
          pin(ctx, u.block, u.expect?.content_hash);
          pushOp(ctx, u);
        }
        retargeted = { blocks: plan.blocks, docs: plan.docs };
        links = ` (retarget ${plural(inbound.length - plan.dangling.length, "link")} in ${plural(plan.docs.length, "document")})`;
      }
      ctx.moves.push({ id: t._id, from: t._path, to: e.to, currentRev: base.currentRev, inbound, retargeted });
      ctx.summary.push(`move ${referencePath(t._path)} → ${referencePath(e.to)}${links}`);
      return;
    }
    case "remove": {
      if ("targets" in e) {
        const ids = e.targets.map((t) => blockTarget(t)._id);
        const expect: Record<string, Expect> = {};
        for (const id of ids) {
          const given = e.expect?.[id];
          const hash = pin(ctx, id, given?.content_hash);
          expect[kernelBlockId(ctx, id)] = { ...(given ?? {}), content_hash: hash };
        }
        const line = `remove ${ids.length === 1 ? blockName(ctx, ids[0]!) : plural(ids.length, "block")} from ${docOfBlocks(ctx, ids)}`;
        pushOp(ctx, { op: "remove", blocks: ids.map((id) => kernelBlockId(ctx, id)), expect });
        ctx.summary.push(line);
        return;
      }
      const t = docTarget(e.target);
      if (isNewSymbol(t._id)) throw new MutationError("target_missing", `${t._id} is a document this plan creates; it cannot be removed in the same plan`, { symbol: t._id });
      const base = readDocBase(ctx.store.db, t._id);
      if (!base) throw docMissing(t._id);
      if (!ctx.docBases.has(t._id)) ctx.docBases.set(t._id, base);
      ctx.tombstones.push({ id: t._id, path: t._path, currentRev: base.currentRev });
      ctx.summary.push(`remove ${referencePath(t._path)}`);
      return;
    }
    case "split": {
      const id = blockTarget(e.target)._id;
      const { docId } = blockInfo(ctx, id);
      checkRevision(ctx, docId, e.expect);
      const hash = pin(ctx, id, e.expect?.content_hash);
      const name = blockName(ctx, id);
      pushOp(ctx, { op: "split", block: kernelBlockId(ctx, id), at: [...e.at], expect: kernelExpect(e.expect, hash)! });
      ctx.summary.push(`split ${name} at offset${e.at.length === 1 ? "" : "s"} ${e.at.join(", ")} in ${docPathOf(ctx, docId)}`);
      return;
    }
    case "merge": {
      const ids = e.targets.map((t) => blockTarget(t)._id);
      const expect: Record<string, Expect> = {};
      for (const id of ids) {
        const given = e.expect?.[id];
        const hash = pin(ctx, id, given?.content_hash);
        expect[kernelBlockId(ctx, id)] = { ...(given ?? {}), content_hash: hash };
      }
      const line = `merge ${plural(ids.length, "block")} into ${blockName(ctx, ids[0]!)} in ${docOfBlocks(ctx, ids)}`;
      pushOp(ctx, { op: "merge", blocks: ids.map((id) => kernelBlockId(ctx, id)), separator: e.separator, expect });
      ctx.summary.push(line);
      return;
    }
    case "retarget": {
      const plan = linksRepair(ctx.store, ctx.repoId, e.repairs, e.path_glob !== undefined ? { pathGlob: e.path_glob } : {});
      ctx.retargets.push({ effect_index: i, hits: plan.hits, pairs: plan.pairs });
      for (const op of plan.ops) {
        const u = op as Extract<Op, { op: "update" }>;
        pin(ctx, u.block, u.expect?.content_hash);
        pushOp(ctx, u);
      }
      const docs = new Set(plan.hits.map((h) => h._path)).size;
      const pair = e.repairs.length === 1 ? `${e.repairs[0]!.from} → ${e.repairs[0]!.to}` : `over ${plural(e.repairs.length, "pair")}`;
      ctx.summary.push(`retarget ${plural(plan.hits.length, "link")} ${pair} in ${plural(docs, "document")}`);
      return;
    }
  }
}

/**
 * The symbolic minter (§11.4): `b` and `d` mints yield `$new.0, $new.1, …`
 * from `symbols`, so a plan consumes no real id and the kernel (id-agnostic
 * for rendering, ADR-002) renders exact bytes. Planning mints nothing else —
 * `c`/`r`/`x`/`e` are minted inside the commit transaction.
 */
export function symbolicMinter(symbols: SymbolTable): IdMinter {
  return (prefix) => {
    if (prefix === "b") return symbols.alloc("block");
    if (prefix === "d") return symbols.alloc("document");
    throw new Error(`the effect planner mints only b/d ids, not ${prefix}`);
  };
}

/** `set document.content`: the whole-document planner's opset, spliced in (placeholders shifted), its frontmatter as a file head. */
function lowerContent(ctx: LoweringContext, docId: string, content: string): void {
  // The whole-document planner verifies its candidates by dry-run applies,
  // which mint: give them a throwaway symbol table so the plan's own `$new.n`
  // sequence stays the one `execute`'s replay reproduces (the opset's ops carry
  // no minted ids — an insert carries markdown — so nothing leaks).
  const opset = withIdMinter(symbolicMinter(new SymbolTable()), () => planUpdate(ctx.store, ctx.repoId, "", docId, content));
  if (!opset.converges) {
    const why = opset.diagnostics.length > 0 ? ` — ${opset.diagnostics[opset.diagnostics.length - 1]}` : "";
    throw new MutationError("plan_not_convergent", `the proposed content of ${docId} cannot be reproduced by the planner; re-plan${why}`, { doc: docId, diagnostics: opset.diagnostics });
  }
  // The identity consequences, surfaced as `preview.identity[doc]` (3.0; the
  // 3.x `docs_update` result): each planned op by its index in the plan's ops.
  const offset = ctx.ops.length;
  ctx.identity.set(docId, {
    matcher_v: opset.matcherV,
    summary: opset.summary,
    ops: opset.ops.map((p, k) => ({ op_index: offset + k, disposition: p.disposition, blocks: p.blocks, confidence: p.confidence, reason: p.reason, ...(p.detail !== undefined ? { detail: p.detail } : {}) })),
    diagnostics: opset.diagnostics,
  });
  if (opset.ops.length === 0 && !opset.frontmatter) {
    // The content IS the document (the zero-effects rule, §11.7): nothing is
    // loaded, so nothing is ingested and `execute` records no commit — the
    // document's triple is still a precondition (the opset's), so the plan is
    // `stale_plan` once the document moves on.
    const base = readDocBase(ctx.store.db, docId);
    if (!base) throw docMissing(docId);
    if (!ctx.docBases.has(docId)) ctx.docBases.set(docId, base);
    return;
  }
  const d = ctx.planner.ensureDoc(docId);
  if (opset.frontmatter) {
    // The whole-document planner's frontmatter keeps the leading trivia in
    // front (its legacy `set_frontmatter`); as a file head that is `leading + raw`.
    const head = d.leadingTrivia + (opset.frontmatter.raw ?? "");
    ctx.planner.setHead(docId, head);
    ctx.heads.set(docId, head);
  }
  for (const p of opset.ops) pushOp(ctx, shiftPlaceholders(p.op, offset));
}

