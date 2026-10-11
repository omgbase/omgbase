// Relationship candidates by reflection over the query — THE inference module.
//
// Everything the picker knows about "which relationships does this query talk
// about" is derived here from the public `@omgbase/oqx` AST plus the result
// rows. When omgbase ships a `query_analyze` tool that returns candidates with
// roles, that tool becomes the data source and `inferCandidates` the fallback;
// nothing else in the UI reads the AST (lib/hints.ts reuses the helpers here).
//
// Rules (in priority order of the LAYOUT default):
//   1. `follow` destinations —
//        - `refs(<field>)` (surface 1.5 — resolves the document references a
//          property holds to live doc rows; `refs(^<field>)` reads the field one
//          scope out): the frontmatter relation `<field>`, direction `forward`
//          (the frontier row owns the field and names its successors).
//        - a plain relation: `doc.out` / `out` / `$it.out` is the link graph,
//          `doc.in` / `in` / `$it.in` the backlink graph (direction `backward`:
//          stored edges point successor → frontier); any other bare name is
//          taken as a frontmatter relation, although `follow before` over a list
//          of paths follows the STRINGS (the engine refuses the hit; lib/hints.ts
//          says so under the editor).
//        - a destination block (`$repo.docs collect { where … }`, `^docs collect
//          { … }`, `$it.in collect { … }`, `refs(before) collect { … }`): a
//          `refs(<field>)` receiver names `<field>` `forward` (the frontier's
//          field); then every frontmatter-looking property its correlated
//          `where` reads — a bare ident on the candidate row
//          (`after.contains("/" + ^$path)`, `("/" + ^$path) in list(after)`) →
//          `after`, direction `backward` (the edge lives on the successor and
//          points at the frontier); an outer ref (`("/" + $path) in ^before`) →
//          `before`, direction `forward`; a `refs(<field>)` receiver of a nested
//          directive (`refs(after) exists { where $path == ^^$path }`) → the
//          same two cases (`refs(after)` backward, `refs(^before)` forward); a
//          literal compared with `src_field` / `predicate` under `doc.in_edges`
//          / `doc.out_edges` / `edges` → that relation (`in_edges` forward,
//          `out_edges` backward; the field is `field` since surface 3.0 and
//          `src_field` before — both are read).
//   2. `order by` keys — a non-intrinsic key is a SEQUENCE candidate: edges are
//        consecutive pairs in result order (no fetch), direction forward.
//   3. inferred from rows — a projected field whose value is a doc path or a
//        list of doc paths (`*.md`, `/`-rooted) is a frontmatter relation;
//        a name in the "looks-backward" vocabulary (`after`, `prev`, `parent`,
//        `depends_on`, …) defaults to `backward`.
//   4. builtin — a query WITHOUT a `follow` always gets the authored link graph
//        to choose from: `doc.out` (links) and `doc.in` (backlinks), so a query
//        that projects no relationship (the starter: `select $path, $title …`)
//        still has edges to draw and relationships in the picker.
//   5. inverse PAIRS — two frontmatter candidates that are one sequence read
//        from both ends (`before`/`after`, `prev`/`next`, `previous`/`next`,
//        `predecessor`/`successor` by NAME; any two whose rows reciprocate —
//        A.x ∋ B and B.y ∋ A, never A.x ∋ B and A.y ∋ B — by DATA) get a
//        combined candidate named `x/y` (kind `sequence`, source `pair`) whose
//        edges are the union of both fields' edges normalised to ONE direction,
//        earlier → later: a `forward` member's edge (owner → target, `before`)
//        is kept, a `backward` member's (`after`) is flipped (lib/edges.ts
//        `pairEdges`). A repository that authors only `after` thus lays out
//        along the pair. The pair is read-only in the editing sense (edit a
//        member field instead); hovering it highlights both members. When the
//        repository's field definitions carry `inverse_of`, that is the source
//        of truth and this detection becomes the fallback.
// Edge default: a pair is drawn and its members are not; otherwise every
// `follow` candidate is drawn; inferred path fields are drawn only when the
// query has no `follow`; the builtin `doc.out` is drawn only when nothing else
// is (no follow, no inferred field); `doc.in` and sequence candidates are never
// drawn by default. Layout default: the first pair, else the first follow
// candidate, else the first sequence key, else the first inferred field
// (timeline words first), else none (force) — a builtin is never the axis.
//
// A `refs(before)` candidate IS the `before` candidate: same name, same kind,
// merged with the inferred one from the rows, written the same way (lib/edit.ts
// looks only at name, kind and the rows).

import type { Expr, Follow, OpNode, Query, Span, Where } from "@omgbase/oqx";
import { HIT_ENVELOPE_KEYS, hitPath, rowRef } from "./paths.ts";

export type Direction = "forward" | "backward";
export type CandidateSource = "follow" | "order by" | "inferred" | "builtin" | "pair";
export type CandidateKind =
  | "frontmatter" // a frontmatter relation: edges rows whose authored field (`field`; `src_field` before 3.0) == name
  | "links" // doc.out — authored links
  | "backlinks" // doc.in — authored links, reversed
  | "sequence"; // an order-by key (consecutive result rows) or an inverse pair (both fields, one direction)

/** The two fields of an inverse pair, by the way their stored edges run along
 * the sequence: the `forward` field's edge owner → target points earlier →
 * later (`before`: the owner precedes the target), the `backward` field's
 * points later → earlier (`after`: the owner follows the target). */
export interface InversePair {
  forward: string;
  backward: string;
  /** How the pair was recognised: the sequence vocabulary, or reciprocal rows. */
  by: "name" | "data";
}

export interface Candidate {
  /** The relation name as the UI shows it (`before`, `doc.out`, `date`, `before/after`). */
  name: string;
  kind: CandidateKind;
  /** Every place it came from (deduped). */
  sources: CandidateSource[];
  /** Source spans (code points) of the AST mentions, for the editor to highlight. */
  spans: Span[];
  defaults: { edge: boolean; layout: boolean; direction: Direction };
  /** Set on a combined inverse-pair candidate (rule 5): its two member fields. */
  pair?: InversePair;
}

export type Row = Record<string, unknown>;

const BACKWARD_WORDS = /^(after|follows?|succeeds?|prev(ious)?|predecessor|parent|parents|depends?_?on|requires?|derived_?from|sources?|replaces|supersedes)$/i;

/** The sequence vocabulary read from both ends (rule 5, by name): `forward` is
 * the field whose owner precedes what it names, `backward` the one whose owner
 * follows it. Only sequence pairs — `parent`/`children` is a tree, not an order. */
export const SEQUENCE_PAIRS: readonly { forward: string; backward: string }[] = [
  { forward: "before", backward: "after" },
  { forward: "next", backward: "prev" },
  { forward: "next", backward: "previous" },
  { forward: "successor", backward: "predecessor" },
];

/** The combined candidate's name: the two fields in the order the vocabulary
 * lists them (`before/after`, `prev/next`); a data-detected pair reads
 * forward/backward. */
export function pairName(pair: Pick<InversePair, "forward" | "backward">): string {
  const order = PAIR_NAME_ORDER.find((o) => o.includes(pair.forward) && o.includes(pair.backward));
  return order ? `${order[0]}/${order[1]}` : `${pair.forward}/${pair.backward}`;
}
const PAIR_NAME_ORDER: readonly [string, string][] = [["before", "after"], ["prev", "next"], ["previous", "next"], ["predecessor", "successor"]];
const TIMELINE_WORDS = /^(before|after|next|prev(ious)?|follows?|precedes?|succeeds?|then|parent|child(ren)?)$/i;
// The hit envelope under both spellings (`$id`/`$path` since surface 3.0,
// `id`/`path` before — lib/paths.ts `HIT_ENVELOPE_KEYS`) plus the walk intrinsics.
const ROW_META = new Set([...HIT_ENVELOPE_KEYS, "$depth", "$stop", "$leaf", "$frontier", "$ordinal", "$doc_id"]);

/** Relations of a row that yield rows by themselves (spec/surface §1.2) — a
 * `follow` over one of these is not a frontmatter field, so no `refs()` hint. */
export const STRUCTURAL_RELATIONS = new Set(["in", "out", "in_edges", "out_edges", "children", "subsections", "nodes", "blocks", "section", "doc"]);

interface Mention {
  name: string;
  kind: CandidateKind;
  source: CandidateSource;
  span: Span;
  direction: Direction;
}

/** The pure inference. `query` may be null (unparsable source) — rows alone
 * still yield inferred candidates. */
export function inferCandidates(query: Query | null, rows: readonly Row[] = []): Candidate[] {
  const mentions: Mention[] = [];
  if (query?.follow) mentions.push(...followMentions(query.follow));
  if (query?.orderBy) {
    for (const spec of query.orderBy) {
      const name = identName(spec.expr);
      if (name && !name.startsWith("$")) {
        mentions.push({ name, kind: "sequence", source: "order by", span: spec.span, direction: spec.desc ? "backward" : "forward" });
      }
    }
  }
  for (const name of pathValuedFields(rows)) {
    mentions.push({
      name, kind: "frontmatter", source: "inferred", span: [0, 0],
      direction: BACKWARD_WORDS.test(name) ? "backward" : "forward",
    });
  }
  if (!query?.follow) {
    // No walk: the authored link graph is always there to draw.
    mentions.push({ name: "doc.out", kind: "links", source: "builtin", span: [0, 0], direction: "forward" });
    mentions.push({ name: "doc.in", kind: "backlinks", source: "builtin", span: [0, 0], direction: "backward" });
  }
  return roleDefaults(withPairs(merge(mentions), rows));
}

// ---- inverse pairs (rule 5) ---------------------------------------------------

/** Rule 5: the inverse pairs among the frontmatter candidates — by the
 * sequence vocabulary, then by reciprocal rows for the fields left over. Each
 * field is in at most one pair; a field never pairs with itself. */
export function detectPairs(candidates: readonly Pick<Candidate, "name" | "kind" | "defaults">[], rows: readonly Row[] = []): InversePair[] {
  const fields = candidates.filter((c) => c.kind === "frontmatter" && !c.name.includes(".") && !c.name.startsWith("$")).map((c) => c.name);
  const present = new Set(fields);
  const taken = new Set<string>();
  const out: InversePair[] = [];
  for (const p of SEQUENCE_PAIRS) {
    if (present.has(p.forward) && present.has(p.backward) && !taken.has(p.forward) && !taken.has(p.backward)) {
      out.push({ ...p, by: "name" });
      taken.add(p.forward); taken.add(p.backward);
    }
  }
  if (rows.length === 0) return out;
  for (let i = 0; i < fields.length; i++) {
    for (let j = i + 1; j < fields.length; j++) {
      const a = fields[i]!, b = fields[j]!;
      if (taken.has(a) || taken.has(b) || !reciprocal(rows, a, b)) continue;
      // Which end is which: the backward vocabulary decides; else the first field is forward.
      const [forward, backward] = BACKWARD_WORDS.test(a) && !BACKWARD_WORDS.test(b) ? [b, a] : [a, b];
      out.push({ forward, backward, by: "data" });
      taken.add(a); taken.add(b);
    }
  }
  return out;
}

/** The rows show `a` and `b` as inverses: at least one A.a ∋ B with B.b ∋ A,
 * and never a row naming the same document under both fields (that is two
 * relations pointing the same way, not one read from both ends). */
export function reciprocal(rows: readonly Row[], a: string, b: string): boolean {
  const byPath = new Map<string, Row>();
  for (const row of rows) {
    const p = hitPath(row);
    if (p !== null) byPath.set(rootedPath(p), row);
  }
  let hits = 0;
  for (const row of rows) {
    const p = hitPath(row);
    if (p === null) continue;
    const self = rootedPath(p);
    const aRefs = refsOf(row[a]);
    const bRefs = refsOf(row[b]);
    if (aRefs.some((r) => bRefs.includes(r))) return false;
    for (const target of aRefs) {
      const other = byPath.get(target);
      if (other && refsOf(other[b]).includes(self)) hits++;
    }
    for (const target of bRefs) {
      const other = byPath.get(target);
      if (other && refsOf(other[a]).includes(self)) hits++;
    }
  }
  return hits > 0;
}

/** The rooted paths a field value references: path strings, and rows that
 * surfaced as values (`{ $id, $path }` since 3.0, `{ id, path }` before). */
function refsOf(v: unknown): string[] {
  const one = (x: unknown): string | null => (looksLikeDocPath(x) ? rootedPath(x as string) : rowRef(x)?.path ?? null);
  if (Array.isArray(v)) return v.map(one).filter((p): p is string => p !== null);
  const p = one(v);
  return p === null ? [] : [p];
}

function rootedPath(p: string): string {
  return p.startsWith("/") ? p : `/${p}`;
}

/** Insert one combined candidate per detected pair, just before its first
 * member, with both members' spans so hovering it lights both in the editor. */
function withPairs(candidates: Candidate[], rows: readonly Row[]): Candidate[] {
  const pairs = detectPairs(candidates, rows);
  if (pairs.length === 0) return candidates;
  const out: Candidate[] = [];
  const inserted = new Set<string>();
  for (const c of candidates) {
    const pair = pairs.find((p) => (p.forward === c.name || p.backward === c.name) && c.kind === "frontmatter");
    if (pair && !inserted.has(pairName(pair))) {
      inserted.add(pairName(pair));
      const members = candidates.filter((m) => m.kind === "frontmatter" && (m.name === pair.forward || m.name === pair.backward));
      out.push({
        name: pairName(pair), kind: "sequence", sources: ["pair"],
        spans: members.flatMap((m) => m.spans),
        defaults: { edge: false, layout: false, direction: "forward" },
        pair,
      });
    }
    out.push(c);
  }
  return out;
}

function merge(mentions: Mention[]): Candidate[] {
  const byName = new Map<string, Candidate>();
  for (const m of mentions) {
    const key = `${m.kind === "sequence" ? "seq:" : ""}${m.name}`;
    const existing = byName.get(key);
    if (existing) {
      if (!existing.sources.includes(m.source)) existing.sources.push(m.source);
      if (m.span[1] > m.span[0]) existing.spans.push(m.span);
      continue;
    }
    byName.set(key, {
      name: m.name, kind: m.kind, sources: [m.source],
      spans: m.span[1] > m.span[0] ? [m.span] : [],
      defaults: { edge: false, layout: false, direction: m.direction },
    });
  }
  return [...byName.values()];
}

function roleDefaults(candidates: Candidate[]): Candidate[] {
  const hasFollow = candidates.some((c) => c.sources.includes("follow"));
  const hasInferred = candidates.some((c) => c.sources.includes("inferred"));
  const paired = new Set(candidates.flatMap((c) => (c.pair ? [c.pair.forward, c.pair.backward] : [])));
  for (const c of candidates) {
    // A pair is drawn in place of its members: the members stay listed, undrawn.
    c.defaults.edge = c.pair !== undefined
      || (!(c.kind === "frontmatter" && paired.has(c.name)) && (c.sources.includes("follow")
      || (!hasFollow && c.sources.includes("inferred"))
      || (!hasFollow && !hasInferred && c.kind === "links" && c.sources.includes("builtin"))));
  }
  const axis =
    candidates.find((c) => c.pair !== undefined) ??
    candidates.find((c) => c.sources.includes("follow")) ??
    candidates.find((c) => c.kind === "sequence") ??
    candidates.find((c) => c.sources.includes("inferred") && TIMELINE_WORDS.test(c.name)) ??
    candidates.find((c) => c.sources.includes("inferred"));
  if (axis) axis.defaults.layout = true;
  return candidates;
}

// ---- follow ---------------------------------------------------------------

function followMentions(follow: Follow): Mention[] {
  const out: Mention[] = [];
  for (const dest of follow.destinations) {
    if (dest.kind === "op") {
      out.push(...destinationBlockMentions(dest));
      continue;
    }
    const ref = refsField(dest);
    if (ref) {
      // `follow refs(before)`: the frontier's own field names its successors.
      out.push({ name: ref.name, kind: "frontmatter", source: "follow", span: dest.span, direction: "forward" });
      continue;
    }
    const path = dottedPath(dest);
    if (!path) continue;
    const kind = relationKind(path);
    out.push({ name: path, kind, source: "follow", span: dest.span, direction: kind === "backlinks" ? "backward" : "forward" });
  }
  return out;
}

/** A destination block computes successors per frontier row; its `where` is
 * correlated (`^` = the frontier row). Read the relation names off it. */
function destinationBlockMentions(op: OpNode): Mention[] {
  const out: Mention[] = [];
  // `refs(before) collect { where … }` — the receiver is the frontier's field.
  const receiver = refsField(op.receiver);
  if (receiver) out.push({ name: receiver.name, kind: "frontmatter", source: "follow", span: op.receiver.span, direction: "forward" });
  const where = op.sub.where;
  if (!where) return out;
  forEachScalar(where, (expr) => {
    // `<succ prop>.contains(^…)` / `<succ prop> == ^…` — the successor's own
    // property names the relation; the edge points successor → frontier.
    if (mentionsOuter(expr)) {
      for (const name of rowProps(expr)) {
        out.push({ name, kind: "frontmatter", source: "follow", span: expr.span, direction: "backward" });
      }
      // `… in ^before` / `… == ^before` — the frontier's property; frontier → successor.
      for (const name of outerProps(expr)) {
        out.push({ name, kind: "frontmatter", source: "follow", span: expr.span, direction: "forward" });
      }
    }
  });
  forEachOp(where, (inner) => {
    // `refs(after) exists { where $path == ^^$path }` — the candidate row's field
    // names the frontier (backward); `refs(^before) exists { … }` — the frontier's
    // field names the candidate (forward).
    const ref = refsField(inner.receiver);
    if (ref) {
      out.push({ name: ref.name, kind: "frontmatter", source: "follow", span: inner.receiver.span, direction: ref.outer ? "forward" : "backward" });
      return;
    }
    // `doc.in_edges exists { where field == "before" … }` (`src_field` before 3.0; or out_edges / $repo.edges).
    const receiverPath = dottedPath(inner.receiver) ?? "";
    const viaIn = receiverPath.endsWith("in_edges");
    const viaOut = receiverPath.endsWith("out_edges");
    if (!viaIn && !viaOut && !receiverPath.endsWith("edges")) return;
    if (!inner.sub.where) return;
    forEachScalar(inner.sub.where, (expr) => {
      const lit = fieldLiteral(expr, ["field", "src_field", "predicate"]);
      if (lit) out.push({ name: lit, kind: "frontmatter", source: "follow", span: expr.span, direction: viaOut ? "backward" : "forward" });
    });
  });
  return out;
}

/** What a plain relation path walks: `doc.out`/`out`/`$it.out` the link graph,
 * `doc.in`/`in`/`$it.in` the backlink graph, anything else a frontmatter field. */
export function relationKind(path: string): CandidateKind {
  const bare = path.replace(/^\$it\./, "").replace(/^doc\./, "");
  if (bare === "out") return "links";
  if (bare === "in") return "backlinks";
  return "frontmatter";
}

/** `refs(<field>)` / `refs(^<field>)`: the field whose document references are
 * resolved, and whether it is read one scope out. Null for anything else
 * (another function, a method call, a `$`-intrinsic argument, a literal). */
export function refsField(expr: Expr): { name: string; outer: boolean } | null {
  if (expr.kind !== "call" || expr.recv !== null || expr.name !== "refs" || expr.args.length !== 1) return null;
  const arg = expr.args[0]!;
  if (arg.kind === "ident" && !arg.name.startsWith("$")) return { name: arg.name, outer: false };
  if (arg.kind === "outer" && !arg.name.startsWith("$")) return { name: arg.name, outer: true };
  return null;
}

// ---- AST helpers (public AST only) -----------------------------------------

function forEachScalar(where: Where, f: (expr: Expr) => void): void {
  switch (where.kind) {
    case "and": case "or": where.parts.forEach((p) => forEachScalar(p, f)); return;
    case "not": forEachScalar(where.expr, f); return;
    case "scalar": f(where.expr); return;
    case "op": return; // nested directives are reported by forEachOp
  }
}

function forEachOp(where: Where, f: (op: OpNode) => void): void {
  switch (where.kind) {
    case "and": case "or": where.parts.forEach((p) => forEachOp(p, f)); return;
    case "not": forEachOp(where.expr, f); return;
    case "scalar": return;
    case "op": f(where); return;
  }
}

function children(expr: Expr): Expr[] {
  switch (expr.kind) {
    case "member": return [expr.recv];
    case "call": return [...(expr.recv ? [expr.recv] : []), ...expr.args];
    case "unary": return [expr.expr];
    case "binary": case "logical": case "in": return [expr.left, expr.right];
    case "range": return [expr.lo, expr.hi].filter((e): e is Expr => e !== null);
    default: return [];
  }
}

function walk(expr: Expr, f: (e: Expr) => void): void {
  f(expr);
  for (const c of children(expr)) walk(c, f);
}

function mentionsOuter(expr: Expr): boolean {
  let found = false;
  walk(expr, (e) => { if (e.kind === "outer") found = true; });
  return found;
}

/** Bare property reads of the current row (not intrinsics, not call names). */
function rowProps(expr: Expr): string[] {
  const names: string[] = [];
  walk(expr, (e) => {
    if (e.kind === "ident" && !e.name.startsWith("$")) names.push(e.name);
  });
  return [...new Set(names)];
}

/** `^name` reads that are properties (not `^$path`-style intrinsics). */
function outerProps(expr: Expr): string[] {
  const names: string[] = [];
  walk(expr, (e) => {
    if (e.kind === "outer" && !e.name.startsWith("$")) names.push(e.name);
  });
  return [...new Set(names)];
}

/** `ident` or a `member` chain over idents, as `a.b.c`. */
export function dottedPath(expr: Expr): string | null {
  if (expr.kind === "ident") return expr.name;
  if (expr.kind === "member") {
    const base = dottedPath(expr.recv);
    return base ? `${base}.${expr.name}` : null;
  }
  return null;
}

function identName(expr: Expr): string | null {
  return expr.kind === "ident" ? expr.name : null;
}

/** `<field> == "lit"` (either side) for one of `fields`. */
function fieldLiteral(expr: Expr, fields: string[]): string | null {
  if (expr.kind !== "binary" || expr.op !== "==") return null;
  const sides = [[expr.left, expr.right], [expr.right, expr.left]] as const;
  for (const [a, b] of sides) {
    const name = identName(a);
    if (name && fields.includes(name) && b.kind === "lit" && typeof b.value === "string") return b.value;
  }
  return null;
}

// ---- rows -------------------------------------------------------------------

const DOC_PATH = /^\/?(?:[^\s/]+\/)*[^\s/]+\.md$/;

export function looksLikeDocPath(v: unknown): boolean {
  return typeof v === "string" && DOC_PATH.test(v);
}

/** Field names whose values (in any row) are a doc path or a list of them. */
export function pathValuedFields(rows: readonly Row[]): string[] {
  const names = new Set<string>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (ROW_META.has(key) || names.has(key)) continue;
      if (looksLikeDocPath(value)) names.add(key);
      else if (Array.isArray(value) && value.length > 0 && value.every(looksLikeDocPath)) names.add(key);
    }
  }
  return [...names];
}
