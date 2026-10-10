// Edge editing — the pure half. Which relationships can be written, who owns
// the edge, what shape and spelling the new value takes, and the exact
// `docs_set_meta` patch for one toggle. Nothing here talks to a server; the
// page (app.ts) and lib/mutations.ts do the I/O.
//
// Rules:
//   1. WRITABLE candidates are frontmatter relations (not `doc.out`/`doc.in`,
//      which live in the body; not `order by` sequences, which are derived)
//      whose sampled values are document references — a `/`-rooted repo path
//      (`/projects/oqx.md`), a bare repo path (`projects/oqx.md`, `projects/oqx`),
//      or a doc id (`d_77ptprj`) — scalar or list. Anything else is read-only
//      with a reason.
//   2. DIRECTION decides the OWNER: the edge is stored on the document whose
//      frontmatter names the relation. A forward candidate (`before`) toggled
//      selected→target edits `selected.before`; a backward one (`after`, drawn
//      target→selected) edits `target.after`. The inverse field is never written.
//   3. VALUE FORM is inferred per field from its existing values across the
//      rows (leading slash or not, `.md` or not, path vs id). No values →
//      the dominant form among all reference fields in the rows, else a
//      `/`-rooted `.md` path. Mixed forms within one field → refuse.
//   4. MUTATION: scalar → set to the ref / unset on remove; list → append /
//      remove with order preserved and duplicates (by normalized ref) dropped;
//      an emptied list is unset (`emptyListBehavior: "unset"`) or kept as `[]`.

import type { Query } from "@omgbase/oqx";
import type { Candidate, Direction, Row } from "./candidates.ts";

/** How a field spells its references. */
export interface RefForm {
  kind: "path" | "id";
  /** Leading `/` (paths only). */
  rooted: boolean;
  /** `.md` suffix kept (paths only). */
  md: boolean;
}

export const DEFAULT_FORM: RefForm = { kind: "path", rooted: true, md: true };
export const ID_FORM: RefForm = { kind: "id", rooted: false, md: false };

export type Shape = "scalar" | "list";
export type EmptyListBehavior = "unset" | "keep";

/** A shown document: its minted id and its `$path` (bare, `.md`). */
export interface DocRef {
  id: string;
  path: string;
}

// Production ids are `d_` + 7 alphabet characters; the fixture minter uses 1–7
// (spec/store §2.2). Nothing else in the system is spelled `<prefix>_<alnum>`.
const DOC_ID = /^d_[0-9a-hjkmnp-tv-z]{1,7}$/;
// A repo path: segments without whitespace, no scheme, optional `.md`.
const PATH_SEGMENTS = /^\/?(?:[^\s/:]+\/)*[^\s/:]+$/;
// Characters a document path never has as a bare word (`phase: build` is not a path).
const PATHISH = /[/.]/;

export function isDocId(v: unknown): boolean {
  return typeof v === "string" && DOC_ID.test(v);
}

/** The form of one value, or null when it is not a document reference. */
export function classifyRef(v: unknown): RefForm | null {
  if (typeof v !== "string") return null;
  if (isDocId(v)) return ID_FORM;
  if (v.includes("://") || !PATH_SEGMENTS.test(v)) return null;
  const rooted = v.startsWith("/");
  const md = /\.md$/i.test(v);
  // A bare single word (`build`, `index`) is not a reference; a bare word with a
  // `.md` suffix or a slash is.
  if (!rooted && !md && !PATHISH.test(v)) return null;
  // Other extensions (`image.png`) are files, not documents.
  if (!md && /\.[a-z0-9]{1,5}$/i.test(v.replace(/^.*\//, ""))) return null;
  return { kind: "path", rooted, md };
}

export function isDocRef(v: unknown): boolean {
  return classifyRef(v) !== null;
}

/** The identity of a reference regardless of its form: ids as-is, paths with
 * the leading `/` and `.md` stripped. */
export function refKey(v: string): string {
  if (isDocId(v)) return v;
  return v.replace(/^\/+/, "").replace(/\.md$/i, "");
}

/** Does `v` refer to `node` (by id or by path in any form)? */
export function sameRef(v: unknown, node: DocRef): boolean {
  if (typeof v !== "string") return false;
  return v === node.id || refKey(v) === refKey(node.path);
}

/** Spell a reference to `node` in `form`. */
export function formatRef(node: DocRef, form: RefForm): string {
  if (form.kind === "id") return node.id;
  const bare = node.path.replace(/^\/+/, "");
  const body = form.md ? (/\.md$/i.test(bare) ? bare : `${bare}.md`) : bare.replace(/\.md$/i, "");
  return form.rooted ? `/${body}` : body;
}

export function describeForm(f: RefForm): string {
  if (f.kind === "id") return "doc id";
  return `${f.rooted ? "/" : ""}path${f.md ? ".md" : ""}`;
}

export function sameForm(a: RefForm, b: RefForm): boolean {
  return a.kind === b.kind && a.rooted === b.rooted && a.md === b.md;
}

// ---- sampling the rows -----------------------------------------------------------

/** The non-null values of `field` across the rows (lists kept whole). */
export function fieldValues(rows: readonly Row[], field: string): unknown[] {
  const out: unknown[] = [];
  for (const row of rows) {
    const v = row[field];
    if (v !== undefined && v !== null) out.push(v);
  }
  return out;
}

function flatten(values: readonly unknown[]): unknown[] {
  return values.flatMap((v) => (Array.isArray(v) ? v : [v]));
}

/** Every sampled element is a document reference (empty lists count as nothing). */
export function allRefs(values: readonly unknown[]): boolean {
  return flatten(values).every(isDocRef);
}

/** The one form the sampled references share; null when nothing was sampled;
 * `"mixed"` when they disagree. Non-reference values are ignored here (rule 1
 * rejects them before this runs). */
export function inferRefForm(values: readonly unknown[]): RefForm | null | "mixed" {
  let form: RefForm | null = null;
  for (const v of flatten(values)) {
    const f = classifyRef(v);
    if (!f) continue;
    if (!form) form = f;
    else if (!sameForm(form, f)) return "mixed";
  }
  return form;
}

/** The forms present among the sampled references, deduped (for messages). */
export function formsOf(values: readonly unknown[]): RefForm[] {
  const out: RefForm[] = [];
  for (const v of flatten(values)) {
    const f = classifyRef(v);
    if (f && !out.some((o) => sameForm(o, f))) out.push(f);
  }
  return out;
}

/** The dominant shape among the sampled values (ties → list); null when none. */
export function inferShape(values: readonly unknown[]): Shape | null {
  let lists = 0;
  let scalars = 0;
  for (const v of values) {
    if (Array.isArray(v)) lists++;
    else scalars++;
  }
  if (lists === 0 && scalars === 0) return null;
  return lists >= scalars ? "list" : "scalar";
}

const ROW_META = new Set(["id", "path", "$path", "$depth", "$stop", "$leaf", "$frontier", "$ordinal", "$id", "$doc_id"]);

/** Row fields whose values are all document references (scalar or list). */
export function refValuedFields(rows: readonly Row[]): string[] {
  const names = new Set<string>();
  const rejected = new Set<string>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (ROW_META.has(key) || rejected.has(key) || value === null || value === undefined) continue;
      const elems = Array.isArray(value) ? value : [value];
      if (elems.length > 0 && elems.every(isDocRef)) names.add(key);
      else { names.delete(key); rejected.add(key); }
    }
  }
  return [...names];
}

/** The most common form (and shape) across all reference fields in the rows. */
export function dominantForm(rows: readonly Row[]): { form: RefForm; shape: Shape } | null {
  const formCounts = new Map<string, { form: RefForm; n: number }>();
  let lists = 0;
  let scalars = 0;
  for (const field of refValuedFields(rows)) {
    const values = fieldValues(rows, field);
    for (const v of values) {
      if (Array.isArray(v)) lists++;
      else scalars++;
    }
    for (const v of flatten(values)) {
      const f = classifyRef(v);
      if (!f) continue;
      const key = describeForm(f);
      const e = formCounts.get(key);
      if (e) e.n++;
      else formCounts.set(key, { form: f, n: 1 });
    }
  }
  const best = [...formCounts.values()].sort((a, b) => b.n - a.n)[0];
  if (!best) return null;
  return { form: best.form, shape: lists >= scalars ? "list" : "scalar" };
}

// ---- editability -----------------------------------------------------------------

export type Editability =
  | { writable: true; form: RefForm; shape: Shape; formSource: "field" | "rows" | "default" }
  | { writable: false; reason: string };

/** Rule 1 + rule 3 for one candidate. `serverCanWrite` is false when the server
 * (or the gateway in front of it) does not offer `docs_set_meta`. */
export function editability(c: Pick<Candidate, "name" | "kind">, rows: readonly Row[], serverCanWrite = true): Editability {
  if (c.kind === "links" || c.kind === "backlinks") return { writable: false, reason: "links live in the body" };
  if (c.kind === "sequence") return { writable: false, reason: `derived from order by ${c.name}` };
  if (c.name.includes(".") || c.name.startsWith("$")) return { writable: false, reason: "not a frontmatter field" };
  if (!serverCanWrite) return { writable: false, reason: "the server offers no docs_set_meta tool (a gateway's tool allowlist must include it)" };
  const values = fieldValues(rows, c.name);
  if (values.length > 0 && !allRefs(values)) return { writable: false, reason: "values are not document references" };
  const form = inferRefForm(values);
  if (form === "mixed") {
    return { writable: false, reason: `mixed value forms in ${c.name} (${formsOf(values).map(describeForm).join(", ")}) — make them agree first` };
  }
  const shape = inferShape(values);
  if (form) return { writable: true, form, shape: shape ?? "list", formSource: "field" };
  const dom = dominantForm(rows);
  if (dom) return { writable: true, form: dom.form, shape: shape ?? dom.shape, formSource: "rows" };
  return { writable: true, form: DEFAULT_FORM, shape: shape ?? "list", formSource: "default" };
}

// ---- direction → owner --------------------------------------------------------------

/** Rule 2: who stores the edge. Forward: the selected document's field names the
 * target; backward: the target's field names the selected document. */
export function ownerFor<T>(direction: Direction, selected: T, target: T): { owner: T; other: T } {
  return direction === "backward" ? { owner: target, other: selected } : { owner: selected, other: target };
}

/** Fields the query projects under their own name (`select before` — not
 * `select b: before`, not a computed expression), so a row's value for them is
 * the document's current value and no `docs_read` is needed. */
export function projectedFields(query: Query | null): string[] {
  if (!query) return [];
  const out: string[] = [];
  for (const item of query.select) {
    if (item.kind === "field" && item.lift === 0 && item.expr.kind === "ident" && item.expr.name === item.name && !item.name.startsWith("$")) out.push(item.name);
  }
  return out;
}

// ---- the patch ---------------------------------------------------------------------

export type Patch =
  | { kind: "set"; value: unknown }
  | { kind: "unset" }
  | { kind: "noop"; reason: string }
  | { kind: "refuse"; reason: string };

export interface ToggleOptions {
  /** The field's shape when it has no value yet. */
  shape: Shape;
  emptyListBehavior: EmptyListBehavior;
}

/** Dedupe references by identity, first occurrence wins, order preserved. */
export function dedupeRefs(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = refKey(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/** Rule 4: the patch that toggles `target` in a field whose current value is
 * `current`. `present` is what the UI believes — the patch is computed from the
 * value, so a stale belief yields a `noop` rather than a wrong write. */
export function planToggle(current: unknown, target: DocRef, present: boolean, form: RefForm, opts: ToggleOptions): Patch {
  const ref = formatRef(target, form);
  if (current === undefined || current === null) {
    if (present) return { kind: "noop", reason: "nothing to remove — the field is empty" };
    return { kind: "set", value: opts.shape === "list" ? [ref] : ref };
  }
  if (typeof current === "string") {
    const matches = sameRef(current, target);
    if (present) return matches ? { kind: "unset" } : { kind: "noop", reason: `the field names ${current}, not ${ref}` };
    if (matches) return { kind: "noop", reason: "already present" };
    return { kind: "set", value: ref };
  }
  if (Array.isArray(current)) {
    if (!current.every((v) => typeof v === "string")) return { kind: "refuse", reason: "the list holds non-string values" };
    const list = current as string[];
    if (present) {
      const kept = dedupeRefs(list.filter((v) => !sameRef(v, target)));
      if (kept.length === list.length) return { kind: "noop", reason: `${ref} is not in the list` };
      if (kept.length === 0) return opts.emptyListBehavior === "keep" ? { kind: "set", value: [] } : { kind: "unset" };
      return { kind: "set", value: kept };
    }
    if (list.some((v) => sameRef(v, target))) return { kind: "noop", reason: "already present" };
    return { kind: "set", value: dedupeRefs([...list, ref]) };
  }
  return { kind: "refuse", reason: `the field holds a ${typeof current} value, not a reference` };
}

/** The `docs_set_meta` arguments for a patch (null when nothing is written). */
export function setMetaArgs(field: string, patch: Patch): { set: Record<string, unknown> } | { unset: string[] } | null {
  if (patch.kind === "set") return { set: { [field]: patch.value } };
  if (patch.kind === "unset") return { unset: [field] };
  return null;
}

/** One line for the confirm strip: which file and field change, and how. */
export function describePatch(owner: DocRef, field: string, patch: Patch, previous: unknown): string {
  const was = previous === undefined || previous === null ? "" : ` (was ${JSON.stringify(previous)})`;
  switch (patch.kind) {
    case "set": return `${owner.path} · set ${field}: ${JSON.stringify(patch.value)}${was}`;
    case "unset": return `${owner.path} · unset ${field}${was}`;
    case "noop": return `${owner.path} · ${field} unchanged — ${patch.reason}`;
    case "refuse": return `${owner.path} · ${field} cannot be edited — ${patch.reason}`;
  }
}
