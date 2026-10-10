// Relationship candidates by reflection over the query — THE inference module.
//
// Everything the picker knows about "which relationships does this query talk
// about" is derived here from the public `@omgbase/oqx` AST plus the result
// rows. When omgbase ships a `query_analyze` tool that returns candidates with
// roles, that tool becomes the data source and `inferCandidates` the fallback;
// nothing else in the UI reads the AST.
//
// Rules (in priority order of the LAYOUT default):
//   1. `follow` destinations —
//        - a plain relation (`before`, `doc.out`, `doc.in`): the relation itself;
//          `doc.out` is the link graph, `doc.in` the backlink graph (direction
//          `backward`: stored edges point successor → frontier).
//        - a destination block (`$repo.docs collect { where … }`): every
//          frontmatter-looking property its correlated `where` reads —
//          a bare ident on the candidate row (`after.contains("/" + ^$path)`)
//          → `after`, direction `backward` (the edge lives on the successor and
//          points at the frontier); an outer ref (`("/" + $path) in ^before`)
//          → `before`, direction `forward`; a literal compared with
//          `src_field` / `predicate` under `doc.in_edges` / `doc.out_edges` /
//          `edges` → that relation (`in_edges` forward, `out_edges` backward).
//   2. `order by` keys — a non-intrinsic key is a SEQUENCE candidate: edges are
//        consecutive pairs in result order (no fetch), direction forward.
//   3. inferred from rows — a projected field whose value is a doc path or a
//        list of doc paths (`*.md`, `/`-rooted) is a frontmatter relation;
//        a name in the "looks-backward" vocabulary (`after`, `prev`, `parent`,
//        `depends_on`, …) defaults to `backward`.
// Edge default: every `follow` candidate is drawn; inferred path fields are drawn
// only when the query has no `follow`; sequence candidates are never drawn by
// default. Layout default: the first follow candidate, else the first sequence
// key, else the first inferred field (timeline words first), else none (force).

import type { Expr, Follow, OpNode, Query, Span, Where } from "@omgbase/oqx";

export type Direction = "forward" | "backward";
export type CandidateSource = "follow" | "order by" | "inferred";
export type CandidateKind =
  | "frontmatter" // a frontmatter relation: edges rows with src_field == name
  | "links" // doc.out — authored links
  | "backlinks" // doc.in — authored links, reversed
  | "sequence"; // an order-by key: consecutive result rows

export interface Candidate {
  /** The relation name as the UI shows it (`before`, `doc.out`, `date`). */
  name: string;
  kind: CandidateKind;
  /** Every place it came from (deduped). */
  sources: CandidateSource[];
  /** Source spans (code points) of the AST mentions, for the editor to highlight. */
  spans: Span[];
  defaults: { edge: boolean; layout: boolean; direction: Direction };
}

export type Row = Record<string, unknown>;

const BACKWARD_WORDS = /^(after|follows?|succeeds?|prev(ious)?|parent|parents|depends?_?on|requires?|derived_?from|sources?|replaces|supersedes)$/i;
const TIMELINE_WORDS = /^(before|after|next|prev(ious)?|follows?|precedes?|succeeds?|then|parent|child(ren)?)$/i;
const ROW_META = new Set(["id", "path", "$path", "$depth", "$stop", "$leaf", "$frontier", "$ordinal", "$id", "$doc_id"]);

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
  return roleDefaults(merge(mentions));
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
  for (const c of candidates) {
    c.defaults.edge = c.sources.includes("follow") || (!hasFollow && c.sources.includes("inferred"));
  }
  const axis =
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
    if (dest.kind === "op") out.push(...destinationBlockMentions(dest));
    else {
      const path = dottedPath(dest);
      if (!path) continue;
      const kind: CandidateKind = path === "doc.out" ? "links" : path === "doc.in" ? "backlinks" : "frontmatter";
      out.push({ name: path, kind, source: "follow", span: dest.span, direction: kind === "backlinks" ? "backward" : "forward" });
    }
  }
  return out;
}

/** A destination block computes successors per frontier row; its `where` is
 * correlated (`^` = the frontier row). Read the relation names off it. */
function destinationBlockMentions(op: OpNode): Mention[] {
  const out: Mention[] = [];
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
  // `doc.in_edges exists { where src_field == "before" … }` (or out_edges / $repo.edges).
  forEachOp(where, (inner) => {
    const receiver = dottedPath(inner.receiver) ?? "";
    const viaIn = receiver.endsWith("in_edges");
    const viaOut = receiver.endsWith("out_edges");
    if (!viaIn && !viaOut && !receiver.endsWith("edges")) return;
    if (!inner.sub.where) return;
    forEachScalar(inner.sub.where, (expr) => {
      const lit = fieldLiteral(expr, ["src_field", "predicate"]);
      if (lit) out.push({ name: lit, kind: "frontmatter", source: "follow", span: expr.span, direction: viaOut ? "backward" : "forward" });
    });
  });
  return out;
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
function dottedPath(expr: Expr): string | null {
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
