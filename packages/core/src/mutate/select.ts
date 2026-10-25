import { OqxError, parse, type Query, type SelectItem } from "@omgbase/oqx";
import type { Store } from "../core/store/store.js";
import { TUPLE_HINT, bracketListAsTuple, checkRootSpellings, oqxRunQuery, reservedAlias, type OqxHit } from "../oqx-js/run.js";
import { rootTarget } from "../oqx-js/planner.js";
import { FilterInvalid } from "../core/filter-invalid.js";
import {
  EFFECT_OPS, EXPRESSION_LEADER, bareTarget, effectInvalid, findDocumentTarget, isNewSymbol, isTargetId, looksLikePath, validateEffect, validateTarget,
  type Effect, type EffectTarget, type ShapeFixContext,
} from "./effects.js";
import { MutationError } from "./tree.js";
import { fixRequest, narrowedTo, withMember, type FixRequest } from "./canonical.js";

// Query-directed planning (spec/mutate §11.8, 3.1): an OQX **selector** plus
// effect **templates** compile into the concrete effects the planner lowers.
// The selector is a producer of effects, never a second write engine — the
// plan that comes out has today's shape plus a frozen `selection` block.
//
// Pipeline: `parse(select)` → `checkRootSpellings` → the static admission pass
// (§5 of the design: consumer, root, no follow / body from / offset / distinct /
// values; templates row-shaped, `{ oqx }` only in the slots below) → the AST
// rewrite (one `field` item per `{ oqx }` slot appended AFTER the user's items
// on the RAW tree, so `resolveAliases` in the runner inlines a user alias a
// template reads) → `oqxRunQuery` with `limit = bound + 1` → hits → the row
// binding (hits in result order × templates in order, `k = h·T + t`). The
// expanded list feeds the existing lowering loop unchanged, so the conflict
// tracker gives cross-hit semantics for free. Nothing is spliced as text.
//
// Since 3.2 (§11.8 "Sugar") the `-> expr` leader is the written form of a
// `{ oqx }` directive (`desugarEffect` runs before admission, for templates
// and plain effects alike), a bare string is a target, and a plain request —
// no selector — may carry expressions too: each evaluates in its own primary
// target's row through one synthetic query per target (`compilePlain`).

/** The implicit bound on a selection without `expect.max` (hits beyond it are `selection_too_large`). */
export const SELECTION_CEILING = 1000;

export interface SelectionExpect {
  max: number;
}

/** The seventh digested member of a plan's core (§11.4): the selector and its templates AS GIVEN, the hits it bound. */
export interface Selection {
  query: string;
  expect?: SelectionExpect;
  templates: unknown[];
  cardinality: number;
  /** the hit ids, result order */
  identities: string[];
}

/** Where an expanded effect came from (every error from one carries both, §11.8); a plain effect's
 *  expressions (3.2) have a row but no template. */
export interface EffectOrigin {
  template_index?: number;
  row: { _id: string; _path: string };
}

export interface CompiledSelection {
  /** the concrete, validated effects: hits × templates */
  effects: Effect[];
  selection: Selection;
  /** expanded index → its origin */
  origins: EffectOrigin[];
}

/** (3.2) A plain request compiled: the concrete effects and, when any effect carried an expression, the list as written. */
export interface CompiledPlain {
  effects: Effect[];
  /** the effects AS WRITTEN — present only when at least one slot was an expression (the intent record's `templates`) */
  templates?: unknown[];
  /** effect index → the row its expressions were read from (sparse; literal effects have none) */
  origins: (EffectOrigin | undefined)[];
}

// ---- errors -------------------------------------------------------------------------

/** The admission pass's refusal: `filter_invalid { reason, hint: "selection" }`. */
export function selectionInvalid(message: string, data: Record<string, unknown> = {}): MutationError {
  return new MutationError("filter_invalid", message, { reason: message, hint: "selection", ...data });
}

function needsSelector(where: string): MutationError {
  return selectionInvalid(`${where}: an expression target needs a selector — without \`select\` there is no row to read it from`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `{ oqx: "<expression>" }` — exactly that one key. */
function isOqx(v: unknown): v is { oqx: string } {
  return isRecord(v) && Object.keys(v).length === 1 && typeof v.oqx === "string";
}

/** A row rendered as a value by the runner (`{ _id, _path }` and nothing else, spec/surface §1.4). */
function isRowRef(v: unknown): v is { _id: string; _path: string } {
  return isRecord(v) && Object.keys(v).length === 2 && typeof v._id === "string" && typeof v._path === "string";
}

function describeValue(v: unknown): string {
  if (v === null || v === undefined) return "absent";
  if (typeof v === "string") return `a string (${JSON.stringify(v)})`;
  if (typeof v === "number") return `a number (${String(v)})`;
  if (typeof v === "boolean") return `a boolean (${String(v)})`;
  if (Array.isArray(v)) return `a list of ${v.length}`;
  return "an object";
}

// ---- the expression wrapper -----------------------------------------------------------

// OQX has no expression entry point: each `{ oqx: e }` is parsed through this
// wrapper and the one select item taken. A top-level item is scope depth 1 —
// exactly the hit's scope — so `^` and `N^` validate as they will evaluate.
const WRAPPER_PREFIX = "docs { select __omg_x: ";
const WRAPPER_SUFFIX = " }";
const OFFSET_RE = /\(at offset (\d+)\)/;

/** Parse one expression; a parse error's offset is shifted back by the wrapper and forward by `shift` (the `-> ` leader's 3). */
function parseExpression(src: string, here: string, shift = 0): SelectItem {
  let q: Query;
  try {
    q = parse(WRAPPER_PREFIX + src + WRAPPER_SUFFIX);
  } catch (e) {
    if (!(e instanceof OqxError)) throw e;
    // Parse-error offsets are shifted by the wrapper prefix (ASCII, so code points = chars).
    const message = e.message.replace(OFFSET_RE, (_m, n: string) => `(at offset ${Math.max(0, Number(n) - WRAPPER_PREFIX.length) + shift})`);
    throw selectionInvalid(`${here}: ${message}`);
  }
  // The whole source must have been one expression: a query smuggled into the
  // slot (`x where … }` closing the wrapper early does not; `x }` + `{ … }`
  // cannot) parses, but not as one item over `docs`.
  const one = q.select.length === 1 && q.source.kind === "ident" && q.source.name === "docs" && q.from.length === 0 && q.where === null
    && q.orderBy === null && q.follow === null && q.frontier === null && q.limit === null && q.offset === null && !q.distinct && !q.values && q.consumer === "collect";
  if (!one) throw selectionInvalid(`${here}: \`oqx\` must be one expression over the hit, not a query`);
  return q.select[0]!;
}

// ---- the `-> ` sugar (3.2, §11.8 "Sugar") -----------------------------------------------

/** Exactly `-> ` (dash, greater-than, space) at the start: `->x`, ` -> x` and `-->` are literal. */
function isLeader(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(EXPRESSION_LEADER);
}

/**
 * `"-> <expr>"` → `{ oqx: "<expr>" }` — or, when the expression is a bare
 * string literal or a template literal without interpolation, the literal
 * itself (constant folding: `-> "x"` and `"x"` plan identically, and
 * `-> "-> note"` is how a literal that begins with the leader is spelled).
 * A parse error is `filter_invalid { hint: "selection" }` with its offset
 * counted from the start of the written string (past the leader).
 */
export function desugarLeader(v: string, here: string): unknown {
  const src = v.slice(EXPRESSION_LEADER.length);
  const item = parseExpression(src, here, EXPRESSION_LEADER.length);
  if (item.kind === "field") {
    const x = item.expr;
    if (x.kind === "lit" && typeof x.value === "string") return x.value;
    if (x.kind === "template" && x.parts.length === 1) return x.parts[0] as string;
  }
  return { oqx: src };
}

/** The text a stray leader meant literally: a quoted string literal or an interpolation-free template literal folds to its text (as constant folding does), anything else is the rest of the string verbatim. */
function literalOf(v: string): string {
  const src = v.slice(EXPRESSION_LEADER.length);
  try {
    const item = parseExpression(src, "");
    if (item.kind === "field") {
      if (item.expr.kind === "lit" && typeof item.expr.value === "string") return item.expr.value;
      if (item.expr.kind === "template" && item.expr.parts.length === 1 && typeof item.expr.parts[0] === "string") return item.expr.parts[0];
    }
  } catch {
    // not an expression at all: the rest of the string is the literal
  }
  return src;
}

/** A `-> ` string where no expression is admitted — anywhere under `v`. The fix (3.3): the literal form, the same request with that member spelled literally (`literalOf`). */
function refuseLeader(v: unknown, here: string, path: string[], fix: ((path: string[], literal: string) => string) | undefined): void {
  if (isLeader(v)) {
    throw selectionInvalid(`${here}: \`-> \` is not allowed here — this member takes no expression`, fix !== undefined ? { fix: fix(path, literalOf(v)) } : {});
  }
  if (Array.isArray(v)) v.forEach((x, k) => refuseLeader(x, `${here}[${k}]`, [...path, String(k)], fix));
  else if (isRecord(v)) for (const [k, x] of Object.entries(v)) refuseLeader(x, `${here}.${k}`, [...path, k], fix);
}

/**
 * Desugar one effect or template as written (§11.8 "Sugar"), before the shape
 * check and the admission: in every slot that admits an expression — the
 * strings `markdown`, `to`, `path`, `separator`, `at.before` / `at.after`,
 * the JSON `value`, each top-level `create.frontmatter` value, a target's `_id`
 * / `_path`, and a whole target (`into`, `target`, `targets[k]`) — a string
 * beginning `-> ` becomes `{ oqx }` (or folds to its literal); a `-> ` string
 * anywhere else (`expect`, `field`, `op`, a section's `heading_id`, …) is
 * refused. Every other string is literal data, with no escaping and no `${`
 * scanning; a string nested inside a `value` or a frontmatter value is data
 * (the slot is the top-level value, as for `{ oqx }`). Shape problems are the
 * shape check's.
 */
export function desugarEffect(raw: unknown, index: number, request?: FixRequest): unknown {
  if (!isRecord(raw) || typeof raw.op !== "string") return raw;
  const here = `effects[${index}]`;
  const out: Record<string, unknown> = clone(raw);
  const slotKeys = new Set<string>(["op"]);
  // The corrected example of a leader in a literal slot: the request as given with that member spelled literally.
  const literalFix = request === undefined ? undefined : (path: string[], literal: string): string => fixRequest({ ...request, effects: withMember(request.effects, [String(index), ...path], literal) });
  const refuse = (v: unknown, at: string, path: string[]): void => refuseLeader(v, at, path, literalFix);
  const leaderAt = (key: string): void => {
    slotKeys.add(key);
    if (isLeader(out[key])) out[key] = desugarLeader(out[key], `${here}.${key}`);
  };
  const target = (key: string): void => {
    slotKeys.add(key);
    const t = out[key];
    // A bare `-> expr` target: the whole target is the directive (a folded literal stays a bare string for the shape check).
    if (isLeader(t)) out[key] = desugarLeader(t, `${here}.${key}`);
    else if (isRecord(t)) {
      for (const member of ["_id", "_path"] as const) if (isLeader(t[member])) t[member] = desugarLeader(t[member], `${here}.${key}.${member}`);
      for (const k of Object.keys(t)) if (k !== "_id" && k !== "_path") refuse(t[k], `${here}.${key}.${k}`, [key, k]);
    }
  };
  const targets = (): void => {
    slotKeys.add("targets");
    const list = out.targets;
    if (!Array.isArray(list)) return;
    list.forEach((t, k) => {
      if (isLeader(t)) list[k] = desugarLeader(t, `${here}.targets[${k}]`);
      else if (isRecord(t)) {
        if (isLeader(t._id)) t._id = desugarLeader(t._id, `${here}.targets[${k}]._id`);
        for (const m of Object.keys(t)) if (m !== "_id") refuse(t[m], `${here}.targets[${k}].${m}`, ["targets", String(k), m]);
      }
    });
  };
  const at = (): void => {
    slotKeys.add("at");
    const a = out.at;
    if (!isRecord(a)) {
      refuse(a, `${here}.at`, ["at"]);
      return;
    }
    for (const member of ["before", "after"] as const) if (isLeader(a[member])) a[member] = desugarLeader(a[member], `${here}.at.${member}`);
    for (const k of Object.keys(a)) if (k !== "before" && k !== "after") refuse(a[k], `${here}.at.${k}`, ["at", k]);
  };
  switch (out.op) {
    case "create": {
      leaderAt("path");
      leaderAt("markdown");
      slotKeys.add("frontmatter");
      const fm = out.frontmatter;
      if (isRecord(fm)) for (const k of Object.keys(fm)) if (isLeader(fm[k])) fm[k] = desugarLeader(fm[k], `${here}.frontmatter.${k}`);
      break;
    }
    case "insert":
      target("into");
      at();
      leaderAt("markdown");
      break;
    case "set":
      target("target");
      leaderAt("value");
      break;
    case "unset":
      target("target");
      break;
    case "move":
      if ("targets" in out || "into" in out) {
        targets();
        target("into");
        at();
      } else {
        target("target");
        leaderAt("to");
      }
      break;
    case "remove":
      if ("targets" in out) targets();
      else target("target");
      break;
    case "split":
      target("target"); // `at` is byte offsets: no expression
      break;
    case "merge":
      targets();
      leaderAt("separator");
      break;
    case "retarget":
      break; // not row-shaped: no slot
    default:
      return out; // an unknown op: the shape check names it
  }
  for (const key of Object.keys(out)) if (!slotKeys.has(key)) refuse(out[key], `${here}.${key}`, [key]);
  return out;
}

// ---- the templates --------------------------------------------------------------------

type SlotKind = "identity" | "target" | "string" | "json";

interface Slot {
  /** the suffix of the reserved item name (`target`, `into`, `markdown`, `fm_<j>`, `targets_<k>`, …) */
  name: string;
  kind: SlotKind;
  /** `effects[t].<path>` for messages */
  here: string;
  /** the member's path inside the template as written (keys and indices), for a `fix` that rewrites it */
  path: string[];
  expression: string;
  item: SelectItem;
  /** how a bound value lands in the concrete effect */
  put: (effect: Record<string, unknown>, value: unknown) => void;
}

interface Template {
  index: number;
  /** the template with every slot removed; the binder copies it and fills the slots */
  base: Record<string, unknown>;
  slots: Slot[];
  /** when set, the hit's identity lands here (`target` | `into` as a target, `targets` as a one-element list) */
  defaultTarget: { key: string; list: boolean } | null;
}

type Root = "docs" | "blocks" | "nodes";
const HIT_KIND: Record<Root, "document" | "block" | "node"> = { docs: "document", blocks: "block", nodes: "node" };

/** Deep-copy JSON (templates are plain data). */
function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function containsOqx(v: unknown): boolean {
  if (isOqx(v)) return true;
  if (Array.isArray(v)) return v.some(containsOqx);
  if (isRecord(v)) return Object.values(v).some(containsOqx);
  return false;
}

/**
 * Admit one template statically (before the query runs): a row-shaped op, the
 * `{ oqx }` directives only in the slots the design names, every expression
 * parseable, and the template's SHAPE valid with a probe value in each slot
 * (`validateEffect`, the `effects[i]` messages of §11.1, `hint: "arguments"`).
 * `plain` (3.2): a plain effect — no selector — keeps its own target: nothing
 * defaults to a hit, and its primary target may not be an expression (the
 * primary target IS the row the expressions read).
 */
function admitTemplate(raw: unknown, index: number, root: Root, plain: boolean, fix?: ShapeFixContext): Template {
  const here = `effects[${index}]`;
  if (!isRecord(raw) || typeof raw.op !== "string") throw selectionInvalid(`${here}: a template is an effect object whose \`op\` is one of ${EFFECT_OPS.filter((o) => o !== "retarget").join("/")}`);
  if (raw.op === "retarget") throw selectionInvalid(`${here}: \`retarget\` is not row-shaped — it cannot be a selector template`);
  if (!(EFFECT_OPS as readonly string[]).includes(raw.op)) throw selectionInvalid(`${here}: \`op\` must be one of ${EFFECT_OPS.filter((o) => o !== "retarget").join("/")} (got "${raw.op}")`);
  const op = raw.op as Exclude<Effect["op"], "retarget">;
  const base: Record<string, unknown> = clone(raw);
  const slots: Slot[] = [];
  const probe: Record<string, unknown> = clone(raw);
  const slotKeys = new Set<string>();

  const expr = (src: string, at: string): SelectItem => parseExpression(src, `${here}.${at}`);

  // A string-valued member that may be an expression (`markdown`, `to`, `path`, `separator`).
  const stringSlot = (key: string): void => {
    slotKeys.add(key);
    if (!isOqx(raw[key])) return;
    const src = raw[key].oqx;
    delete base[key];
    probe[key] = "$sel";
    slots.push({ name: key, kind: "string", here: `${here}.${key}`, path: [key], expression: src, item: expr(src, key), put: (e, v) => { e[key] = v; } });
  };
  // A JSON-valued member (`value`): the top-level `{ oqx }` is the expression; nested ones are data.
  const jsonSlot = (key: string): void => {
    slotKeys.add(key);
    if (!isOqx(raw[key])) return;
    const src = raw[key].oqx;
    delete base[key];
    probe[key] = null;
    slots.push({ name: key, kind: "json", here: `${here}.${key}`, path: [key], expression: src, item: expr(src, key), put: (e, v) => { e[key] = v; } });
  };
  // A target member: `{ kind, _id: { oqx } }` or `{ kind: "document", _path: { oqx } }`, or (3.2) the whole target
  // `{ oqx }` — the identity the value names; absent → the hit when `defaultable` (never on a plain effect).
  // `probeKind` is a kind the slot admits, standing in for the whole-target expression's unknown kind.
  const targetSlot = (key: string, defaultable: boolean, probeKind: EffectTarget["kind"], primary: boolean): { key: string; list: false } | null => {
    slotKeys.add(key);
    const t = raw[key];
    if (t === undefined) {
      if (!defaultable || plain) return null;
      probe[key] = { kind: HIT_KIND[root], _id: "$sel" };
      return { key, list: false };
    }
    if (isOqx(t)) {
      if (plain && primary) throw needsSelector(`${here}.${key}`);
      const src = t.oqx;
      delete base[key];
      probe[key] = { kind: probeKind, _id: "$sel" };
      slots.push({ name: key, kind: "target", here: `${here}.${key}`, path: [key], expression: src, item: expr(src, key), put: (e, v) => { e[key] = v; } });
      return null;
    }
    if (isRecord(t)) {
      const idX = isOqx(t._id);
      const pathX = isOqx(t._path);
      if (idX && pathX) throw selectionInvalid(`${here}.${key}: give \`_id\` or \`_path\` as an expression, not both`);
      if (idX || pathX) {
        if (plain && primary) throw needsSelector(`${here}.${key}`);
        const member = idX ? "_id" : "_path";
        const src = (t[member] as { oqx: string }).oqx;
        const literal = { ...t };
        delete literal[member];
        base[key] = literal;
        (probe[key] as Record<string, unknown>)[member] = "$sel";
        slots.push({
          name: key, kind: "identity", here: `${here}.${key}.${member}`, path: [key, member], expression: src, item: expr(src, `${key}.${member}`),
          put: (e, v) => { e[key] = { ...(e[key] as Record<string, unknown>), ...identityMember(member, v) }; },
        });
      }
      for (const k of Object.keys(t)) if (k !== "_id" && k !== "_path" && containsOqx(t[k])) throw selectionInvalid(`${here}.${key}.${k}: \`{ oqx }\` is not allowed here`);
    }
    return null;
  };
  // A `targets` list: each element `{ kind: "block", _id: { oqx } }` (or, 3.2, a whole `{ oqx }`) yields one block;
  // absent → `[the hit]` when `defaultable`. The list is always the primary target of its op.
  const targetsSlot = (defaultable: boolean): { key: "targets"; list: true } | null => {
    slotKeys.add("targets");
    const list = raw.targets;
    if (list === undefined) {
      if (!defaultable || plain) return null;
      probe.targets = [{ kind: HIT_KIND[root], _id: "$sel" }];
      return { key: "targets", list: true };
    }
    if (Array.isArray(list)) {
      list.forEach((t, k) => {
        if (isOqx(t)) {
          if (plain) throw needsSelector(`${here}.targets[${k}]`);
          const src = t.oqx;
          (base.targets as unknown[])[k] = {};
          (probe.targets as unknown[])[k] = { kind: "block", _id: "$sel" };
          slots.push({
            name: `targets_${k}`, kind: "target", here: `${here}.targets[${k}]`, path: ["targets", String(k)], expression: src, item: expr(src, `targets[${k}]`),
            put: (e, v) => { (e.targets as unknown[])[k] = v; },
          });
          return;
        }
        if (!isRecord(t)) return;
        if (isOqx(t._path)) throw selectionInvalid(`${here}.targets[${k}]: a block target has \`_id\`, not \`_path\``);
        if (isOqx(t._id)) {
          if (plain) throw needsSelector(`${here}.targets[${k}]._id`);
          const src = t._id.oqx;
          const literal = { ...t };
          delete literal._id;
          (base.targets as unknown[])[k] = literal;
          ((probe.targets as unknown[])[k] as Record<string, unknown>)._id = "$sel";
          slots.push({
            name: `targets_${k}`, kind: "identity", here: `${here}.targets[${k}]._id`, path: ["targets", String(k), "_id"], expression: src, item: expr(src, `targets[${k}]._id`),
            put: (e, v) => { const arr = e.targets as Record<string, unknown>[]; arr[k] = { ...arr[k], ...identityMember("_id", v) }; },
          });
        }
        for (const key of Object.keys(t)) if (key !== "_id" && containsOqx(t[key])) throw selectionInvalid(`${here}.targets[${k}].${key}: \`{ oqx }\` is not allowed here`);
      });
    }
    return null;
  };
  // `at.before` / `at.after` may be an expression yielding a block id.
  const atSlot = (): void => {
    slotKeys.add("at");
    const at = raw.at;
    if (!isRecord(at)) return;
    for (const member of ["before", "after"] as const) {
      if (!isOqx(at[member])) continue;
      const src = at[member].oqx;
      base.at = {};
      probe.at = { [member]: "$sel" };
      slots.push({ name: "at", kind: "string", here: `${here}.at.${member}`, path: ["at", member], expression: src, item: expr(src, `at.${member}`), put: (e, v) => { e.at = { [member]: v }; } });
    }
  };

  let defaultTarget: Template["defaultTarget"] = null;
  switch (op) {
    case "create": {
      stringSlot("path");
      stringSlot("markdown");
      slotKeys.add("frontmatter");
      if (isRecord(raw.frontmatter)) {
        Object.entries(raw.frontmatter).forEach(([k, v], j) => {
          if (!isOqx(v)) return;
          delete (base.frontmatter as Record<string, unknown>)[k];
          (probe.frontmatter as Record<string, unknown>)[k] = null;
          slots.push({ name: `fm_${j}`, kind: "json", here: `${here}.frontmatter.${k}`, path: ["frontmatter", k], expression: v.oqx, item: expr(v.oqx, `frontmatter.${k}`), put: (e, x) => { (e.frontmatter as Record<string, unknown>)[k] = x; } });
        });
      }
      break;
    }
    case "insert":
      defaultTarget = targetSlot("into", true, "document", true);
      atSlot();
      stringSlot("markdown");
      break;
    case "set":
      defaultTarget = targetSlot("target", true, "document", true);
      jsonSlot("value");
      break;
    case "unset":
      defaultTarget = targetSlot("target", true, "document", true);
      break;
    case "move":
      if ("into" in raw) {
        // the block form: `targets` default to the hit, `into` is the destination
        defaultTarget = targetsSlot(true);
        targetSlot("into", false, "document", false);
        atSlot();
      } else {
        defaultTarget = targetSlot("target", true, "document", true);
        stringSlot("to");
      }
      break;
    case "remove": {
      const docForm = "target" in raw || (!("targets" in raw) && root === "docs");
      defaultTarget = docForm ? targetSlot("target", true, "document", true) : targetsSlot(true);
      break;
    }
    case "split":
      defaultTarget = targetSlot("target", true, "block", true);
      break;
    case "merge":
      if (raw.targets === undefined) throw selectionInvalid(`${here}: \`merge\` needs \`targets\` — one hit cannot be merged with itself`);
      targetsSlot(false);
      stringSlot("separator");
      break;
  }
  // Everything else is literal: an expression anywhere else is refused.
  for (const key of Object.keys(raw)) {
    if (slotKeys.has(key) || key === "op") continue;
    if (containsOqx(raw[key])) throw selectionInvalid(`${here}.${key}: \`{ oqx }\` is not allowed here`);
  }
  // The shape, with a probe in every slot (the §11.1 messages, naming `effects[i]`; the §8 shape fixes rewrite the template as written).
  validateEffect(probe, index, fix);
  return { index, base, slots, defaultTarget };
}

/** The `_id`/`_path` member a bound identity value supplies: a string as given, a row ref by its id. */
function identityMember(member: "_id" | "_path", v: unknown): Record<string, unknown> {
  if (isRowRef(v)) return { _id: v._id };
  return { [member]: v };
}

// ---- the request ---------------------------------------------------------------------

function validateExpect(v: unknown): SelectionExpect | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v)) throw selectionInvalid("`expect` must be an object { max }");
  const extra = Object.keys(v).filter((k) => k !== "max");
  if (extra.length > 0) throw selectionInvalid(`\`expect\`: unknown key${extra.length > 1 ? "s" : ""} ${extra.map((k) => `\`${k}\``).join(", ")}`);
  if (typeof v.max !== "number" || !Number.isInteger(v.max) || v.max < 0) throw selectionInvalid("`expect.max` must be a non-negative integer");
  return { max: v.max };
}

/**
 * The fix of a refused selector source (3.3): the same request over an
 * admitted root — `links` becomes `blocks` (a link lives in a block), any other
 * source (`revisions` included) `docs` — spliced over the source's span of the written query.
 */
function rootFix(select: string, source: Query["source"], request: FixRequest | undefined): Record<string, unknown> {
  if (request === undefined) return {};
  const [start, end] = source.span;
  const cps = Array.from(select);
  const root = source.kind === "ident" && source.name === "links" ? "blocks" : "docs";
  return { fix: fixRequest({ ...request, select: cps.slice(0, start).join("") + root + cps.slice(end).join("") }) };
}

/** The static admission of the selector itself (the design's writability pass, first release). */
function admitSelector(select: string, request?: FixRequest): { raw: Query; root: Root } {
  let raw: Query;
  try {
    raw = parse(select);
    checkRootSpellings(raw);
  } catch (e) {
    if (e instanceof OqxError) {
      // (spec/surface 4.11) `id in ["a", "b"]` — the bracket list rewritten to a
      // tuple is the `fix` (the same request over the corrected selector).
      const rewritten = bracketListAsTuple(select, e.message);
      if (rewritten === null) throw selectionInvalid(`select: ${e.message}`);
      throw selectionInvalid(`select: ${e.message}${TUPLE_HINT}`, request === undefined ? {} : { fix: fixRequest({ ...request, select: rewritten }) });
    }
    if (e instanceof FilterInvalid) throw selectionInvalid(`select: ${e.message}`);
    throw e;
  }
  const reserved = reservedAlias(raw.select);
  if (reserved) throw selectionInvalid(`select: ${reserved.message}`);
  if (raw.consumer !== "collect" && raw.consumer !== "first" && raw.consumer !== "single") {
    throw selectionInvalid(`select: \`${raw.consumer}\` yields no rows — a selector's consumer is collect, first or single`);
  }
  if (raw.values) throw selectionInvalid("select: a selector yields rows, not `values`");
  const root = rootTarget(raw.source);
  if (root === null && raw.source.kind === "ident" && raw.source.name === "revisions") {
    throw selectionInvalid("select: `revisions` rows have no effect target — select docs, blocks or nodes", rootFix(select, raw.source, request));
  }
  if (root === null) throw selectionInvalid("select: a selector scans a root collection — `docs { … }`, `blocks { … }` or `nodes { … }`", rootFix(select, raw.source, request));
  if (root === "links") throw selectionInvalid("select: `links` rows have no effect target — select docs, blocks or nodes", rootFix(select, raw.source, request));
  if (raw.follow !== null) throw selectionInvalid("select: `follow` is not allowed in a selector — a hit must be a row of the root");
  if (raw.from.length > 0) throw selectionInvalid("select: a body `from` re-projects the rows — a hit must be a row of the root");
  if (raw.offset !== null) throw selectionInvalid("select: `offset` is not allowed — a selection is a set, not a page");
  if (raw.distinct) throw selectionInvalid("select: `distinct` is not allowed in a selector");
  return { raw, root };
}

/** Run a compiled query over the store; an OQX error is the runner's `filter_invalid`. */
function runQuery(store: Store, repoId: string, q: Query, limit: number): { hits: OqxHit[]; truncated: boolean } {
  try {
    const res = oqxRunQuery(store, repoId, q, { limit });
    return { hits: res.hits, truncated: res.truncated };
  } catch (e) {
    if (e instanceof OqxError) throw new FilterInvalid(e.message, "OQX");
    // An unknown name (spec/surface §1.5) is refused before any row is read; a
    // selector's refusal wears the admission prefix and hint like every other.
    if (e instanceof FilterInvalid) throw selectionInvalid(`select: ${e.message}`);
    throw e;
  }
}

// ---- compile ---------------------------------------------------------------------------

/**
 * Compile `{ select, expect?, effects: templates }` into the concrete effects
 * (§11.8): admit statically, rewrite, run once over one snapshot with
 * `limit = bound + 1`, refuse a selection beyond the bound, bind every hit to
 * every template. Reads only.
 */
export function compileSelection(store: Store, repoId: string, select: unknown, expectRaw: unknown, templatesRaw: unknown): CompiledSelection {
  const expect = validateExpect(expectRaw);
  const request: FixRequest = { select, effects: templatesRaw, ...(expectRaw !== undefined ? { expect: expectRaw } : {}) };
  const { rewritten, root, templates } = admitRequest(select, templatesRaw, request);

  const bound = expect?.max ?? SELECTION_CEILING;
  const { hits, truncated } = runQuery(store, repoId, rewritten, bound + 1);
  if (truncated || hits.length > bound) {
    // The fix (3.3): the same request bounded at the selection's actual size — counted
    // by a second, unbounded run when the first page was cut (the engine never plans
    // a partial set, so the page bound is what it is; the count is for the example).
    const count = truncated ? runQuery(store, repoId, rewritten, Number.MAX_SAFE_INTEGER).hits.length : hits.length;
    throw new MutationError("selection_too_large", `the selection has ${truncated ? `more than ${bound}` : String(hits.length)} hits, over the bound of ${bound}${expect === undefined ? " (the implicit ceiling; pass expect.max to raise it)" : ""} — narrow the selector or raise \`expect.max\``, {
      cardinality: truncated ? `>${bound}` : hits.length, max: bound, ...(expect === undefined ? { implicit: true } : {}),
      fix: fixRequest({ select, effects: templatesRaw, expect: { max: count } }),
    });
  }

  // Row → effects: hits in result order × templates in order (k = h·T + t). A
  // selector with `flatten` (oqx 0.25; §11.8) fans out per FLATTENED row: each
  // hit is the parent row (its `_id`/`_path`), the slot items read the bound name
  // (`-> tag`) in the flattened scope, and `expect.max` — the page bound above —
  // counts the flattened hits.
  const effects: Effect[] = [];
  const origins: EffectOrigin[] = [];
  hits.forEach((hit) => {
    for (const t of templates) {
      const k = effects.length;
      const row = { _id: hit._id, _path: hit._path };
      const origin: EffectOrigin = { template_index: t.index, row };
      effects.push(bind(hit, t, k, origin, root, request));
      origins.push(origin);
    }
  });
  const selection: Selection = {
    query: select as string,
    ...(expect !== undefined ? { expect } : {}),
    templates: templatesRaw as unknown[],
    cardinality: hits.length,
    identities: hits.map((h) => h._id),
  };
  return { effects, selection, origins };
}

/** The static half (admission + rewrite; no store): the rewritten query, its root and the admitted templates. */
function admitRequest(select: unknown, templatesRaw: unknown, request?: FixRequest): { rewritten: Query; root: Root; templates: Template[] } {
  if (typeof select !== "string" || select.trim() === "") throw selectionInvalid("`select` must be an OQX query (a non-empty string)");
  if (!Array.isArray(templatesRaw)) throw selectionInvalid("`effects` must be an array of effect templates");
  if (templatesRaw.length === 0) throw selectionInvalid("`effects` must name at least one template");
  const { raw, root } = admitSelector(select, request);
  // Under a selector a template's `into` is bound per hit, so the anchor fix (a parent lookup) does not apply: `parentOf` finds nothing.
  const fix: ShapeFixContext | undefined = request === undefined ? undefined : { request, parentOf: () => null };
  const templates = templatesRaw.map((t, i) => admitTemplate(desugarEffect(t, i, request), i, root, false, fix));
  // The rewrite: the slot items, named `__omg_sel_<t>_<slot>`, appended after
  // the user's items on the raw tree (so a user alias resolves into them).
  const items: SelectItem[] = [];
  for (const t of templates) for (const s of t.slots) items.push({ ...s.item, name: slotName(t.index, s.name) } as SelectItem);
  return { rewritten: { ...raw, select: [...raw.select, ...items] }, root, templates };
}

/** The query a selector request compiles to (admission + rewrite, before any row is read) — `print` it to see what runs. */
export function selectionQuery(select: unknown, templates: unknown): Query {
  return admitRequest(select, templates, { select, effects: templates }).rewritten;
}

function slotName(t: number, slot: string): string {
  return `__omg_sel_${t}_${slot}`;
}

/**
 * The fix of an ambiguous target (3.3): the slot spelled as the FIRST identity the
 * expression yielded (a row by its id), and under a selector the selector narrowed
 * to the row the expression was read from (`expect.max: 1`); a plain request keeps
 * its effects with the slot rewritten.
 */
function ambiguousFix(request: FixRequest, t: Template, s: Slot, hit: OqxHit, root: Root, list: unknown[]): Record<string, unknown> {
  const head = list[0];
  const first = isRowRef(head) ? head._id : head;
  if (typeof first !== "string") return {};
  const effects = withMember(request.effects, [String(t.index), ...s.path], first);
  if (request.select === undefined) return { fix: fixRequest({ effects }) };
  return { fix: fixRequest({ select: narrowedTo(root, hit._id), effects, expect: { max: 1 } }) };
}

/** One hit × one template → the concrete effect (the binding table of §11.8). */
function bind(hit: OqxHit, t: Template, k: number, origin: EffectOrigin, root: Root, request: FixRequest): Effect {
  const e: Record<string, unknown> = clone(t.base);
  const data = { effect_index: k, ...(origin.template_index !== undefined ? { template_index: origin.template_index } : {}), row: origin.row };
  if (t.defaultTarget !== null) {
    const target = { kind: HIT_KIND[root], _id: hit._id };
    e[t.defaultTarget.key] = t.defaultTarget.list ? [target] : target;
  }
  for (const s of t.slots) {
    const v = hit[slotName(t.index, s.name)];
    const absent = v === undefined || v === null;
    switch (s.kind) {
      case "identity":
      case "target": {
        if (absent || (Array.isArray(v) && v.length === 0)) {
          throw new MutationError("target_missing", `${s.here}: the expression yielded no identity for row ${hit._id}`, { ...data, expression: s.expression });
        }
        if (Array.isArray(v)) {
          throw new MutationError("ambiguous_target", `${s.here}: the expression yielded ${v.length} identities for row ${hit._id}; a target resolves to exactly one`, { ...data, expression: s.expression, count: v.length, ...ambiguousFix(request, t, s, hit, root, v) });
        }
        if (typeof v !== "string" && !isRowRef(v)) throw selectionInvalid(`${s.here}: the expression yielded ${describeValue(v)}, not an identity (a string or a row)`, { ...data, expression: s.expression });
        if (s.kind === "identity") {
          s.put(e, v);
          break;
        }
        // (3.2) a whole target: a row by its id's prefix, a string as a bare target (a path → document, an id → its kind).
        const ref = isRowRef(v) ? v._id : v;
        if (!isRowRef(v) && !looksLikePath(ref) && !isTargetId(ref) && !isNewSymbol(ref)) {
          throw selectionInvalid(`${s.here}: the expression yielded ${describeValue(v)}, not an identity (a document path, an id or a row)`, { ...data, expression: s.expression });
        }
        s.put(e, bareTarget(ref, s.here));
        break;
      }
      case "string":
        if (absent) throw selectionInvalid(`${s.here}: the expression yielded absent for row ${hit._id}`, { ...data, expression: s.expression });
        if (typeof v !== "string") throw selectionInvalid(`${s.here}: the expression yielded ${describeValue(v)}, expected a string`, { ...data, expression: s.expression });
        s.put(e, v);
        break;
      case "json":
        if (absent) throw selectionInvalid(`${s.here}: the expression yielded absent for row ${hit._id}${s.name === "value" ? " — use `unset` to remove a key" : ""}`, { ...data, expression: s.expression });
        s.put(e, v);
        break;
    }
  }
  return validateEffect(e, k);
}

// ---- plain requests with expressions (3.2, §11.8 "Sugar") ---------------------------------

const PLACEMENT_KINDS: readonly EffectTarget["kind"][] = ["document", "section", "block"];
const DOCUMENT_KIND: readonly EffectTarget["kind"][] = ["document"];
const BLOCK_KIND: readonly EffectTarget["kind"][] = ["block"];
const SET_KINDS: readonly EffectTarget["kind"][] = ["document", "block", "node"];

/** The row a plain effect's expressions read: its primary target's root and id, and the error when that row is gone. */
interface Scope {
  root: Root;
  id: string;
  missing: () => MutationError;
}

/**
 * The primary target of a plain effect (the §11.8 table's: `target` of
 * set/unset/split and of a document move/remove, `into` of insert, the first
 * of `targets` for the block forms) as a row: a `create` has none; an
 * expression there needs a selector; a `$new.n` has no row yet.
 */
function scopeOf(store: Store, repoId: string, e: Record<string, unknown>, i: number): Scope {
  const here = `effects[${i}]`;
  let key: string;
  let v: unknown;
  let kinds: readonly EffectTarget["kind"][];
  let placement = false;
  const first = (): void => {
    if (!Array.isArray(e.targets) || e.targets.length === 0) validateEffect(e, i); // the shape check's `targets` message
    key = "targets[0]";
    v = (e.targets as unknown[])[0];
    kinds = BLOCK_KIND;
  };
  switch (e.op) {
    case "create":
      throw selectionInvalid(`${here}: a \`create\` has no row — an expression on a create needs a selector (\`select\`)`);
    case "insert":
      key = "into"; v = e.into; kinds = PLACEMENT_KINDS; placement = true;
      break;
    case "set":
      key = "target"; v = e.target; kinds = SET_KINDS;
      break;
    case "unset":
      key = "target"; v = e.target; kinds = DOCUMENT_KIND;
      break;
    case "move":
      if ("targets" in e || "into" in e) first();
      else { key = "target"; v = e.target; kinds = DOCUMENT_KIND; }
      break;
    case "remove":
      if ("targets" in e) first();
      else { key = "target"; v = e.target; kinds = DOCUMENT_KIND; }
      break;
    case "split":
      key = "target"; v = e.target; kinds = BLOCK_KIND;
      break;
    case "merge":
      first();
      break;
    default:
      validateEffect(e, i); // an unknown op (or `retarget`): the shape check refuses it
      throw effectInvalid(`${here}: \`op\` ${JSON.stringify(e.op)} is not row-shaped`);
  }
  if (isOqx(v) || (isRecord(v) && (isOqx(v._id) || isOqx(v._path)))) throw needsSelector(`${here}.${key!}`);
  const t = validateTarget(v, `${here}.${key!}`, kinds!);
  switch (t.kind) {
    case "symbol":
      throw selectionInvalid(`${here}.${key!}: ${t._id} has no row yet — it is created by this plan; use a literal target or a selector`);
    case "document": {
      const d = findDocumentTarget(store, repoId, t);
      return { root: "docs", id: d._id, missing: () => new MutationError("doc_missing", `doc ${d._id} not found`, { doc: d._id }) };
    }
    case "block":
      return {
        root: "blocks", id: t._id,
        missing: () => (placement ? new MutationError("parent_missing", `parent ${t._id} not found`) : new MutationError("block_missing", `block ${t._id} not found`, { block: t._id })),
      };
    case "section":
      return { root: "blocks", id: t.heading_id, missing: () => new MutationError("parent_missing", `parent ${t.heading_id} not found`) };
    case "node":
      return { root: "nodes", id: t._id, missing: () => new MutationError("block_missing", `node ${t._id} not found`, {}) };
  }
}

/**
 * Compile a plain `effects` list (no selector): desugar the `-> ` leaders,
 * then — when nothing is an expression — the shape check as before (3.0
 * byte-identical). Otherwise each effect with expressions is admitted as a
 * template over its own primary target's row: the effects are grouped by that
 * row's identity, one synthetic query per identity — `from <root> where _id ==
 * "<id>"` with the slot items appended, named `__omg_sel_<effectIndex>_<slot>`
 * — runs, and the row binds the slots exactly as a selector's hit would. The
 * concrete effects feed the lowering unchanged; `templates` is the list as
 * written, for the intent record.
 */
/**
 * The live-row lookup behind the anchor fix (§8, 3.4): a block's parent id
 * (`null` at the top level) and its document's path, from the `blocks` row
 * that is not deleted; `null` for an id the store does not know (a `$new.n`,
 * a typo) — then there is no fix.
 */
function parentLookup(store: Store): ShapeFixContext["parentOf"] {
  return (id) => {
    const row = store.db
      .prepare("SELECT b.parent_block AS parent, d.path AS path FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE b.block_id = ? AND b.deleted_at IS NULL")
      .get(id) as { parent: string | null; path: string } | undefined;
    return row === undefined ? null : { parent: row.parent, path: row.path };
  };
}

export function compilePlain(store: Store, repoId: string, raw: unknown): CompiledPlain {
  if (!Array.isArray(raw)) throw effectInvalid("`effects` must be an array of effects");
  if (raw.length === 0) throw effectInvalid("`effects` must name at least one effect");
  const request: FixRequest = { effects: raw };
  const fix: ShapeFixContext = { request, parentOf: parentLookup(store) };
  const desugared = raw.map((e, i) => desugarEffect(e, i, request));
  if (!desugared.some(containsOqx)) return { effects: desugared.map((e, i) => validateEffect(e, i, fix)), origins: [] };

  const effects: Effect[] = [];
  const origins: (EffectOrigin | undefined)[] = [];
  const scopes = new Map<string, Scope & { members: Template[] }>();
  desugared.forEach((e, i) => {
    if (!containsOqx(e) || !isRecord(e)) {
      effects[i] = validateEffect(e, i, fix);
      return;
    }
    const scope = scopeOf(store, repoId, e, i);
    const t = admitTemplate(e, i, scope.root, true, fix);
    if (t.slots.length === 0) {
      // `{ oqx }` only inside data (a nested `value`): literal, as for a template.
      effects[i] = validateEffect(e, i, fix);
      return;
    }
    const key = `${scope.root}:${scope.id}`;
    let g = scopes.get(key);
    if (g === undefined) {
      g = { ...scope, members: [] };
      scopes.set(key, g);
    }
    g.members.push(t);
  });
  for (const g of scopes.values()) {
    const q = parse(`from ${g.root} where _id == ${JSON.stringify(g.id)}`);
    const items: SelectItem[] = [];
    for (const t of g.members) for (const s of t.slots) items.push({ ...s.item, name: slotName(t.index, s.name) } as SelectItem);
    const { hits } = runQuery(store, repoId, { ...q, select: items }, 2);
    const hit = hits[0];
    if (hit === undefined) throw g.missing();
    for (const t of g.members) {
      const origin: EffectOrigin = { row: { _id: hit._id, _path: hit._path } };
      effects[t.index] = bind(hit, t, t.index, origin, g.root, request);
      origins[t.index] = origin;
    }
  }
  return { effects, templates: raw, origins };
}
