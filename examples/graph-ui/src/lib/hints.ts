// Non-blocking advice about a parsed query: things that run (or fail at the
// server) but mean something other than the author most likely intends. Pure;
// `<oqx-query-editor>` shows them under its status line and `describeQueryError`
// (lib/errors.ts) uses the same reading to turn the engine's generic remedy into
// the concrete one.
//
// Today's one rule: `follow <bare field>` — `follow before` over a frontmatter
// list of paths follows the STRINGS, and since surface 1.5 the server refuses
// the hit (`filter_invalid`, "a hit must be a document, block, node or edge
// row"). `follow refs(before)` resolves the references to the documents.
// Not flagged: `refs(…)`, a destination block, a dotted path (`doc.out`,
// `$it.in`), a `$`-intrinsic, and the structural relations (`in`, `out`,
// `children`, `subsections`, …) which yield rows by themselves.

import type { Query, Span } from "@omgbase/oqx";
import { STRUCTURAL_RELATIONS, dottedPath, refsField } from "./candidates.ts";

export interface Hint {
  kind: "follow-bare-field";
  /** The field the destination names. */
  field: string;
  /** Code-point span of the destination in the source. */
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

export function queryHints(query: Query | null): Hint[] {
  return bareFollowFields(query).map(({ field, span }) => ({
    kind: "follow-bare-field",
    field,
    span,
    message: `\`${field}\` holds document references; \`follow refs(${field})\` walks the documents (a bare field follows the strings)`,
  }));
}

/** Split a hint message into prose and code runs (odd indices are code). */
export function messageRuns(message: string): string[] {
  return message.split("`");
}
