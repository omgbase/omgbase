// Non-blocking advice about a parsed query: things that run (or fail at the
// server) but mean something other than the author most likely intends. Pure;
// `<oqx-query-editor>` shows them under its status line and `describeQueryError`
// (lib/errors.ts) uses the same reading to turn the engine's generic remedy into
// the concrete one.
//
// Rules:
//   1. `follow <bare field>` — `follow before` over a frontmatter list of paths
//      follows the STRINGS, and the server refuses the hit (`filter_invalid`,
//      "a hit must be a document, block, node or edge row"). `follow
//      refs(before)` resolves the references to the documents. Not flagged:
//      `refs(…)`, a destination block (`_out_links { from _dst }`), a
//      dotted path (`$it._out_links`, 4.x's `doc.out_links`), a `$`-name
//      (OQX's own), and the structural relations (`_out_links`, `_in_links`,
//      `_children`, `_subsections`, … and their bare 4.x spellings) which
//      yield rows by themselves.
//   2. the path form: every path the server returns is `/`-rooted (spec/surface
//      §1 "Paths"), so `"/" + _path` (or `"/" + ^_path`, `"/" + _dst_path`;
//      the bare `path`/`dst_path` on 4.x) adds a second slash to an already
//      rooted path and never matches an authored reference — use the attribute
//      alone. A literal (`_path == "a.md"`) and another attribute (`_path ==
//      ^^_path`) are not flagged: the server roots a literal itself.

import type { Expr, Query, Span } from "@omgbase/oqx";
import { visit } from "@omgbase/oqx";
import { STRUCTURAL_RELATIONS, dottedPath, refsField } from "./candidates.ts";

export type HintKind = "follow-bare-field" | "path-already-rooted";

export interface Hint {
  kind: HintKind;
  /** The code the hint is about: the field a destination names, or the path
   * attribute as spelled (`_path`, `^_path`, `^^_dst_path`). */
  field: string;
  /** Code-point span of the offending source. */
  span: Span;
  /** Prose with the code parts in backticks (the editor renders them as <code>). */
  message: string;
}

/** `follow` destinations that are a bare frontmatter-looking field. */
export function bareFollowFields(query: Query | null): { field: string; span: Span }[] {
  if (!query?.follow) return [];
  const out: { field: string; span: Span }[] = [];
  for (const dest of query.follow.destinations) {
    if (dest.kind === "op" || refsField(dest)) continue;
    const path = dottedPath(dest);
    if (!path || path.includes(".") || path.startsWith("$") || STRUCTURAL_RELATIONS.has(path)) continue;
    out.push({ field: path, span: dest.span });
  }
  return out;
}

/** Hints for `query`. */
export function queryHints(query: Query | null): Hint[] {
  const hints: Hint[] = bareFollowFields(query).map(({ field, span }) => ({
    kind: "follow-bare-field",
    field,
    span,
    message: `\`${field}\` holds document references; \`follow refs(${field})\` walks the documents (a bare field follows the strings)`,
  }));
  if (query) {
    hints.push(...slashPrefixedPaths(query).map((p) => {
      const attribute = p.ref.replace(/^\^+/, "");
      return { kind: "path-already-rooted" as const, field: p.ref, span: p.span, message: `\`${attribute}\` is already \`/\`-rooted; use \`${p.ref}\`` };
    }));
  }
  return hints.sort((a, b) => a.span[0] - b.span[0]);
}

// ---- the path form ---------------------------------------------------------

interface PathMention {
  /** The attribute as spelled (`_path`, `^_path`, `^^_dst_path`). */
  ref: string;
  span: Span;
}

// The path reads: the row's `_path` on every target; a link's destination path,
// `_dst_path` — and the bare 4.x spellings of both.
const PATH_ATTRIBUTES = new Set(["_path", "_dst_path", "path", "dst_path"]);

/** A bare path attribute (`_path`, `^_path`, `^^_dst_path`, …) and its spelling, else null. */
export function pathRef(expr: Expr): string | null {
  if (expr.kind === "ident" && PATH_ATTRIBUTES.has(expr.name)) return expr.name;
  if (expr.kind === "outer" && PATH_ATTRIBUTES.has(expr.name)) return `${"^".repeat(expr.levels)}${expr.name}`;
  return null;
}

/** `"/" + _path` (a `/` literal prefixed to a path attribute), else null. */
export function slashPrefixedPath(expr: Expr): string | null {
  if (expr.kind !== "binary" || expr.op !== "+" || expr.left.kind !== "lit" || expr.left.value !== "/") return null;
  return pathRef(expr.right);
}

/** Every `"/" + <path attribute>` in the query (the slash is redundant). */
export function slashPrefixedPaths(query: Query): PathMention[] {
  const out: PathMention[] = [];
  visit(query, {
    enter(node) {
      const ref = slashPrefixedPath(node as Expr);
      if (ref) out.push({ ref, span: node.span });
    },
  });
  return out;
}

/** Split a hint message into prose and code runs (odd indices are code). */
export function messageRuns(message: string): string[] {
  return message.split("`");
}
