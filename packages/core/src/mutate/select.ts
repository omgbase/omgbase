import { OqxError, parse, type Query, type SelectItem } from "@omgbase/oqx";
import type { Store } from "../core/store/store.js";
import { checkRootSpellings, oqxRunQuery, reservedAlias, type OqxHit } from "../oqx-js/run.js";
import { rootTarget } from "../oqx-js/planner.js";
import { FilterInvalid } from "../search/cel/parser.js";
import { EFFECT_OPS, validateEffect, type Effect } from "./effects.js";
import { MutationError } from "./tree.js";

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

/** Where an expanded effect came from (every error from one carries both, §11.8). */
export interface EffectOrigin {
  template_index: number;
  row: { id: string; path: string };
}

export interface CompiledSelection {
  /** the concrete, validated effects: hits × templates */
  effects: Effect[];
  selection: Selection;
  /** expanded index → its origin */
  origins: EffectOrigin[];
}

// ---- errors -------------------------------------------------------------------------

/** The admission pass's refusal: `filter_invalid { reason, hint: "selection" }`. */
export function selectionInvalid(message: string, data: Record<string, unknown> = {}): MutationError {
  return new MutationError("filter_invalid", message, { reason: message, hint: "selection", ...data });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `{ oqx: "<expression>" }` — exactly that one key. */
function isOqx(v: unknown): v is { oqx: string } {
  return isRecord(v) && Object.keys(v).length === 1 && typeof v.oqx === "string";
}

/** A row rendered as a value by the runner (`{ id, path }` and nothing else, spec/surface §1.4). */
function isRowRef(v: unknown): v is { id: string; path: string } {
  return isRecord(v) && Object.keys(v).length === 2 && typeof v.id === "string" && typeof v.path === "string";
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
const WRAPPER_PREFIX = "select __omg_x: ";
const WRAPPER_SUFFIX = " from docs";
const OFFSET_RE = /\(at offset (\d+)\)/;

function parseExpression(src: string, here: string): SelectItem {
  let q: Query;
  try {
    q = parse(WRAPPER_PREFIX + src + WRAPPER_SUFFIX);
  } catch (e) {
    if (!(e instanceof OqxError)) throw e;
    // Parse-error offsets are shifted by the wrapper prefix (ASCII, so code points = chars).
    const message = e.message.replace(OFFSET_RE, (_m, n: string) => `(at offset ${Math.max(0, Number(n) - WRAPPER_PREFIX.length)})`);
    throw selectionInvalid(`${here}: ${message}`);
  }
  // The whole source must have been one expression: a query smuggled into the
  // slot (`x from blocks where …`) parses, but not as one item over `docs`.
  const one = q.select.length === 1 && q.source.kind === "ident" && q.source.name === "docs" && q.from.length === 0 && q.where === null
    && q.orderBy === null && q.follow === null && q.frontier === null && q.limit === null && q.offset === null && !q.distinct && !q.values && q.consumer === "collect";
  if (!one) throw selectionInvalid(`${here}: \`oqx\` must be one expression over the hit, not a query`);
  return q.select[0]!;
}

// ---- the templates --------------------------------------------------------------------

type SlotKind = "identity" | "string" | "json";

interface Slot {
  /** the suffix of the reserved item name (`target`, `into`, `markdown`, `fm_<j>`, `targets_<k>`, …) */
  name: string;
  kind: SlotKind;
  /** `effects[t].<path>` for messages */
  here: string;
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
 */
function admitTemplate(raw: unknown, index: number, root: Root): Template {
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
    slots.push({ name: key, kind: "string", here: `${here}.${key}`, expression: src, item: expr(src, key), put: (e, v) => { e[key] = v; } });
  };
  // A JSON-valued member (`value`): the top-level `{ oqx }` is the expression; nested ones are data.
  const jsonSlot = (key: string): void => {
    slotKeys.add(key);
    if (!isOqx(raw[key])) return;
    const src = raw[key].oqx;
    delete base[key];
    probe[key] = null;
    slots.push({ name: key, kind: "json", here: `${here}.${key}`, expression: src, item: expr(src, key), put: (e, v) => { e[key] = v; } });
  };
  // A target member: `{ kind, id: { oqx } }` or `{ kind: "document", path: { oqx } }`; absent → the hit when `defaultable`.
  const targetSlot = (key: string, defaultable: boolean): { key: string; list: false } | null => {
    slotKeys.add(key);
    const t = raw[key];
    if (t === undefined) {
      if (!defaultable) return null;
      probe[key] = { kind: HIT_KIND[root], id: "$sel" };
      return { key, list: false };
    }
    if (isRecord(t)) {
      const idX = isOqx(t.id);
      const pathX = isOqx(t.path);
      if (idX && pathX) throw selectionInvalid(`${here}.${key}: give \`id\` or \`path\` as an expression, not both`);
      if (idX || pathX) {
        const member = idX ? "id" : "path";
        const src = (t[member] as { oqx: string }).oqx;
        const literal = { ...t };
        delete literal[member];
        base[key] = literal;
        (probe[key] as Record<string, unknown>)[member] = "$sel";
        slots.push({
          name: key, kind: "identity", here: `${here}.${key}.${member}`, expression: src, item: expr(src, `${key}.${member}`),
          put: (e, v) => { e[key] = { ...(e[key] as Record<string, unknown>), ...identityMember(member, v) }; },
        });
      }
      for (const k of Object.keys(t)) if (k !== "id" && k !== "path" && containsOqx(t[k])) throw selectionInvalid(`${here}.${key}.${k}: \`{ oqx }\` is not allowed here`);
    }
    return null;
  };
  // A `targets` list: each element `{ kind: "block", id: { oqx } }` yields one block id; absent → `[the hit]` when `defaultable`.
  const targetsSlot = (defaultable: boolean): { key: "targets"; list: true } | null => {
    slotKeys.add("targets");
    const list = raw.targets;
    if (list === undefined) {
      if (!defaultable) return null;
      probe.targets = [{ kind: HIT_KIND[root], id: "$sel" }];
      return { key: "targets", list: true };
    }
    if (Array.isArray(list)) {
      list.forEach((t, k) => {
        if (!isRecord(t)) return;
        if (isOqx(t.path)) throw selectionInvalid(`${here}.targets[${k}]: a block target has \`id\`, not \`path\``);
        if (isOqx(t.id)) {
          const src = t.id.oqx;
          const literal = { ...t };
          delete literal.id;
          (base.targets as unknown[])[k] = literal;
          ((probe.targets as unknown[])[k] as Record<string, unknown>).id = "$sel";
          slots.push({
            name: `targets_${k}`, kind: "identity", here: `${here}.targets[${k}].id`, expression: src, item: expr(src, `targets[${k}].id`),
            put: (e, v) => { const arr = e.targets as Record<string, unknown>[]; arr[k] = { ...arr[k], ...identityMember("id", v) }; },
          });
        }
        for (const key of Object.keys(t)) if (key !== "id" && containsOqx(t[key])) throw selectionInvalid(`${here}.targets[${k}].${key}: \`{ oqx }\` is not allowed here`);
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
      slots.push({ name: "at", kind: "string", here: `${here}.at.${member}`, expression: src, item: expr(src, `at.${member}`), put: (e, v) => { e.at = { [member]: v }; } });
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
          slots.push({ name: `fm_${j}`, kind: "json", here: `${here}.frontmatter.${k}`, expression: v.oqx, item: expr(v.oqx, `frontmatter.${k}`), put: (e, x) => { (e.frontmatter as Record<string, unknown>)[k] = x; } });
        });
      }
      break;
    }
    case "insert":
      defaultTarget = targetSlot("into", true);
      atSlot();
      stringSlot("markdown");
      break;
    case "set":
      defaultTarget = targetSlot("target", true);
      jsonSlot("value");
      break;
    case "unset":
      defaultTarget = targetSlot("target", true);
      break;
    case "move":
      if ("into" in raw) {
        // the block form: `targets` default to the hit, `into` is the destination
        defaultTarget = targetsSlot(true);
        targetSlot("into", false);
        atSlot();
      } else {
        defaultTarget = targetSlot("target", true);
        stringSlot("to");
      }
      break;
    case "remove": {
      const docForm = "target" in raw || (!("targets" in raw) && root === "docs");
      defaultTarget = docForm ? targetSlot("target", true) : targetsSlot(true);
      break;
    }
    case "split":
      defaultTarget = targetSlot("target", true);
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
  // The shape, with a probe in every slot (the §11.1 messages, naming `effects[i]`).
  validateEffect(probe, index);
  return { index, base, slots, defaultTarget };
}

/** The `id`/`path` member a bound identity value supplies: a string as given, a row ref by its id. */
function identityMember(member: "id" | "path", v: unknown): Record<string, unknown> {
  if (isRowRef(v)) return { id: v.id };
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

/** The static admission of the selector itself (the design's writability pass, first release). */
function admitSelector(select: string): { raw: Query; root: Root } {
  let raw: Query;
  try {
    raw = parse(select);
    checkRootSpellings(raw);
  } catch (e) {
    if (e instanceof OqxError) throw selectionInvalid(`select: ${e.message}`);
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
  if (root === null) throw selectionInvalid("select: a selector scans a root collection — `from docs`, `from blocks` or `from nodes`");
  if (root === "links") throw selectionInvalid("select: `links` rows have no effect target — select docs, blocks or nodes");
  if (raw.follow !== null) throw selectionInvalid("select: `follow` is not allowed in a selector — a hit must be a row of the root");
  if (raw.from.length > 0) throw selectionInvalid("select: a body `from` re-projects the rows — a hit must be a row of the root");
  if (raw.offset !== null) throw selectionInvalid("select: `offset` is not allowed — a selection is a set, not a page");
  if (raw.distinct) throw selectionInvalid("select: `distinct` is not allowed in a selector");
  return { raw, root };
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
  const { rewritten, root, templates } = admitRequest(select, templatesRaw);

  const bound = expect?.max ?? SELECTION_CEILING;
  let hits: OqxHit[];
  let truncated: boolean;
  try {
    const res = oqxRunQuery(store, repoId, rewritten, { limit: bound + 1 });
    hits = res.hits;
    truncated = res.truncated;
  } catch (e) {
    if (e instanceof OqxError) throw new FilterInvalid(e.message, "OQX");
    throw e;
  }
  if (truncated || hits.length > bound) {
    throw new MutationError("selection_too_large", `the selection has ${truncated ? `more than ${bound}` : String(hits.length)} hits, over the bound of ${bound}${expect === undefined ? " (the implicit ceiling; pass expect.max to raise it)" : ""} — narrow the selector or raise \`expect.max\``, {
      cardinality: truncated ? `>${bound}` : hits.length, max: bound, ...(expect === undefined ? { implicit: true } : {}),
    });
  }

  // Row → effects: hits in result order × templates in order (k = h·T + t).
  const effects: Effect[] = [];
  const origins: EffectOrigin[] = [];
  hits.forEach((hit) => {
    for (const t of templates) {
      const k = effects.length;
      const row = { id: hit.id, path: hit.path };
      const origin: EffectOrigin = { template_index: t.index, row };
      effects.push(bind(hit, t, k, origin, root));
      origins.push(origin);
    }
  });
  const selection: Selection = {
    query: select as string,
    ...(expect !== undefined ? { expect } : {}),
    templates: templatesRaw as unknown[],
    cardinality: hits.length,
    identities: hits.map((h) => h.id),
  };
  return { effects, selection, origins };
}

/** The static half (admission + rewrite; no store): the rewritten query, its root and the admitted templates. */
function admitRequest(select: unknown, templatesRaw: unknown): { rewritten: Query; root: Root; templates: Template[] } {
  if (typeof select !== "string" || select.trim() === "") throw selectionInvalid("`select` must be an OQX query (a non-empty string)");
  if (!Array.isArray(templatesRaw)) throw selectionInvalid("`effects` must be an array of effect templates");
  if (templatesRaw.length === 0) throw selectionInvalid("`effects` must name at least one template");
  const { raw, root } = admitSelector(select);
  const templates = templatesRaw.map((t, i) => admitTemplate(t, i, root));
  // The rewrite: the slot items, named `__omg_sel_<t>_<slot>`, appended after
  // the user's items on the raw tree (so a user alias resolves into them).
  const items: SelectItem[] = [];
  for (const t of templates) for (const s of t.slots) items.push({ ...s.item, name: slotName(t.index, s.name) } as SelectItem);
  return { rewritten: { ...raw, select: [...raw.select, ...items] }, root, templates };
}

/** The query a selector request compiles to (admission + rewrite, before any row is read) — `print` it to see what runs. */
export function selectionQuery(select: unknown, templates: unknown): Query {
  return admitRequest(select, templates).rewritten;
}

function slotName(t: number, slot: string): string {
  return `__omg_sel_${t}_${slot}`;
}

/** One hit × one template → the concrete effect (the binding table of §11.8). */
function bind(hit: OqxHit, t: Template, k: number, origin: EffectOrigin, root: Root): Effect {
  const e: Record<string, unknown> = clone(t.base);
  const data = { effect_index: k, template_index: origin.template_index, row: origin.row };
  if (t.defaultTarget !== null) {
    const target = { kind: HIT_KIND[root], id: hit.id };
    e[t.defaultTarget.key] = t.defaultTarget.list ? [target] : target;
  }
  for (const s of t.slots) {
    const v = hit[slotName(t.index, s.name)];
    const absent = v === undefined || v === null;
    switch (s.kind) {
      case "identity": {
        if (absent || (Array.isArray(v) && v.length === 0)) {
          throw new MutationError("target_missing", `${s.here}: the expression yielded no identity for row ${hit.id}`, { ...data, expression: s.expression });
        }
        if (Array.isArray(v)) {
          throw new MutationError("ambiguous_target", `${s.here}: the expression yielded ${v.length} identities for row ${hit.id}; a target resolves to exactly one`, { ...data, expression: s.expression, count: v.length });
        }
        if (typeof v !== "string" && !isRowRef(v)) throw selectionInvalid(`${s.here}: the expression yielded ${describeValue(v)}, not an identity (a string or a row)`, { ...data, expression: s.expression });
        s.put(e, v);
        break;
      }
      case "string":
        if (absent) throw selectionInvalid(`${s.here}: the expression yielded absent for row ${hit.id}`, { ...data, expression: s.expression });
        if (typeof v !== "string") throw selectionInvalid(`${s.here}: the expression yielded ${describeValue(v)}, expected a string`, { ...data, expression: s.expression });
        s.put(e, v);
        break;
      case "json":
        if (absent) throw selectionInvalid(`${s.here}: the expression yielded absent for row ${hit.id}${s.name === "value" ? " — use `unset` to remove a key" : ""}`, { ...data, expression: s.expression });
        s.put(e, v);
        break;
    }
  }
  return validateEffect(e, k);
}
